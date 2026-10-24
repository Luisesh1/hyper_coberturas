/**
 * Registro transaccional de intenciones y fills reales Binance Options.
 * Ningún POST se hace sin intención durable; cada tradeId se aplica una vez.
 */
const dbDefault = require('../db');
const { grossPnl, signedPremium } = require('../services/options/options-utils');
const { botUnderlyings } = require('../services/options/bot-underlyings');

/**
 * El símbolo pertenece a un subyacente de la estrategia (fila de BD): la
 * columna `underlying` o, en un bot multi-subyacente, `params.underlyings`.
 */
function symbolOfStrategy(symbol, row) {
  let params = row?.params;
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { params = null; }
  }
  return botUnderlyings({ underlying: row?.underlying, params })
    .some((u) => String(symbol).startsWith(`${u}-`));
}

const map = (r) => r && ({
  id: Number(r.id), batchId: Number(r.batch_id), strategyId: Number(r.strategy_id),
  userId: Number(r.user_id), action: r.action, positionId: r.position_id == null ? null : Number(r.position_id),
  symbol: r.symbol, side: r.side, quantity: Number(r.requested_qty),
  limitPrice: Number(r.limit_price), processedQty: Number(r.processed_qty),
  clientOrderId: r.client_order_id, orderId: r.exchange_order_id, status: r.status,
  leaseUntil: Number(r.reconcile_lease_until || 0),
  createdAt: Number(r.created_at), deadlineAt: Number(r.deadline_at),
  error: r.last_error, purpose: r.purpose || 'standard', cancelRequested: Boolean(r.cancel_requested),
});

function compareExposure(rows, exchangePositions) {
  if (!Array.isArray(exchangePositions)) throw new Error('Binance positions response is not an array');
    const expected = new Map();
    for (const p of rows) {
      const signed = Number(p.quantity) * (p.side === 'SELL' ? -1 : 1);
      if (!['BUY', 'SELL'].includes(p.side) || !Number.isFinite(signed)) {
        throw new Error('Invalid local live position');
      }
      expected.set(p.symbol, (expected.get(p.symbol) || 0) + signed);
    }
    const actual = new Map();
    for (const p of exchangePositions) {
      const qty = Number(p.quantity);
      if (!p.symbol || !Number.isFinite(qty) || !['LONG', 'SHORT'].includes(p.side)) {
        throw new Error('Invalid Binance live position or direction');
      }
      if (p.quoteAsset != null && p.quoteAsset !== 'USDT') {
        throw new Error('Unsupported Binance options position quote asset');
      }
      if (p.side === 'SHORT' && qty > 1e-9 || p.side === 'LONG' && qty < -1e-9) {
        throw new Error('Binance live position direction disagrees with quantity');
      }
      actual.set(p.symbol, (actual.get(p.symbol) || 0) + qty);
    }
    for (const symbol of new Set([...expected.keys(), ...actual.keys()])) {
      if (Math.abs((expected.get(symbol) || 0) - (actual.get(symbol) || 0)) > 1e-8) {
        throw new Error('Binance exposure mismatch: ' + symbol + '. Manual reconciliation required');
      }
    }
    return true;
}

/** `{ signalId }` si la señal trae un id de fila válido; si no, nada. */
function signalIdOf(signal) {
  const id = Number(signal?.signalId);
  return Number.isSafeInteger(id) && id > 0 ? { signalId: id } : {};
}

function createOptionsLiveOrdersRepository({ db = dbDefault, now = Date.now } = {}) {
  // Reconciliación de posiciones contra el total de la cuenta Binance.
  const EXPOSURE_SQL = `SELECT symbol,side,COALESCE(SUM(quantity),0) AS quantity
         FROM options_strategy_positions
        WHERE user_id=$1 AND mode='live' AND closed_at IS NULL
        GROUP BY symbol,side`;

  async function assertExchangeExposure(userId, exchangePositions) {
    const { rows } = await db.query(EXPOSURE_SQL, [userId]);
    return compareExposure(rows, exchangePositions);
  }

  async function beginBatch({ strategy, action, legs, key, detail, deadlineAt, exchangePositions, autoSignalId = null }) {
    if (!legs.length || !['open', 'close'].includes(action)) throw new Error('Invalid live batch');
    return db.transaction(async (tx) => {
      // Locks entre réplicas: un solo lote sin conciliar por usuario,
      // incluso cuando pertenece a distintos bots.
      const { rows: [current] } = await tx.query(
        'SELECT id,user_id,mode,underlying,params FROM options_strategies WHERE id=$1 FOR UPDATE',
        [strategy.id]
      );
      if (!current || Number(current.user_id) !== Number(strategy.userId) || current.mode !== 'live') {
        throw new Error('Live strategy is no longer active or owned by this user');
      }
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [strategy.userId]);
      const { rows: pending } = await tx.query(
        "SELECT b.id FROM options_live_batches b WHERE b.user_id=$1 AND b.status <> 'completed' " +
        "AND EXISTS (SELECT 1 FROM options_live_orders o WHERE o.batch_id=b.id AND o.purpose='standard') LIMIT 1",
        [strategy.userId]
      );
      if (pending.length) return null;
      // Verificar la misma instantánea de Binance bajo lock de usuario,
      // contra el libro confirmado en la transacción. Si cambió desde
      // el preflight, abortar: jamás confiar en límites calculados antes.
      const { rows: currentExposure } = await tx.query(EXPOSURE_SQL, [strategy.userId]);
      compareExposure(currentExposure, exchangePositions);
      // Un cierre no puede vender/comprar más contratos que los realmente
      // abiertos ni cerrar posiciones de otro bot. Validar ANTES del POST.
      if (action === 'close') {
        const ids = legs.map((leg) => Number(leg.positionId));
        if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
            new Set(ids).size !== ids.length) {
          throw new Error('Invalid or duplicate closing position');
        }
        const { rows: held } = await tx.query(
          `SELECT id, strategy_id, user_id, mode, symbol, side, quantity
             FROM options_strategy_positions
            WHERE id = ANY($1::bigint[]) AND closed_at IS NULL FOR UPDATE`,
          [ids]
        );
        const byId = new Map(held.map((p) => [Number(p.id), p]));
        // Se protege la carrera: TP creado después del preflight y antes
        // de esta transacción. Bajo el mismo advisory lock, guardar la
        // intención de salida y cancelar TP en lugar de enviar doble cierre.
        const { rows: protectedTp } = await tx.query(
          "SELECT id FROM options_live_orders WHERE position_id=ANY($1::bigint[]) " +
          "AND purpose='take_profit' AND status<>'final' LIMIT 1", [ids]
        );
        if (protectedTp.length) {
          const time = now();
          for (const leg of legs) {
            const p = byId.get(Number(leg.positionId));
            if (!p || Number(p.user_id) !== Number(strategy.userId) ||
                Number(p.strategy_id) !== Number(strategy.id) || p.mode !== 'live' ||
                p.symbol !== leg.symbol || p.side === leg.side ||
                Number(leg.quantity) > Number(p.quantity) + 1e-9) {
              throw new Error('Closing order exceeds verified live position');
            }
            await tx.query(
              `INSERT INTO options_live_exit_requests
               (position_id,strategy_id,user_id,reason,created_at,updated_at)
               VALUES ($1,$2,$3,'tp_race_cancel',$4,$4)
               ON CONFLICT (position_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
              [p.id, strategy.id, strategy.userId, time]
            );
          }
          await tx.query(
            "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$2 " +
            "WHERE position_id=ANY($1::bigint[]) AND purpose='take_profit' AND status<>'final'",
            [ids, time]
          );
          return null;
        }
        for (const leg of legs) {
          const p = byId.get(Number(leg.positionId));
          if (!p || Number(p.strategy_id) !== Number(strategy.id) ||
              Number(p.user_id) !== Number(strategy.userId) ||
              p.mode !== 'live' || p.symbol !== leg.symbol ||
              p.side === leg.side ||
              !Number.isFinite(Number(leg.quantity)) ||
              Number(leg.quantity) <= 0 ||
              Number(leg.quantity) > Number(p.quantity) + 1e-9) {
            throw new Error('Closing order exceeds verified live position');
          }
        }
      }
      if (action === 'open') {
        // Una sola entrada histórica por usuario durante el piloto.
        // Se consulta BAJO el advisory lock existente del usuario: dos
        // estrategias concurrentes no pueden consumir el permiso a la vez.
        // Las entradas anteriores, incluso canceladas o con 0 fills,
        // también consumen el piloto: revisión humana antes de repetir.
        if (process.env.OPTIONS_LIVE_TRADING_ENABLED === 'true' &&
            process.env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'true') {
          const { rows: alreadyAttempted } = await tx.query(
            "SELECT id FROM options_live_orders WHERE user_id=$1 AND action='open' LIMIT 1",
            [strategy.userId]
          );
          if (alreadyAttempted.length) {
            throw new Error('One-shot pilot already used; no additional live entries');
          }
          if (legs.length !== 1 || legs[0].side !== 'BUY' ||
              !/^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(legs[0].symbol || '')) {
            throw new Error('One-shot pilot allows only one ETH BUY leg');
          }
        }
        const { rows: exits } = await tx.query(
          "SELECT r.id FROM options_live_exit_requests r " +
          "JOIN options_strategy_positions p ON p.id=r.position_id " +
          "WHERE r.user_id=$1 AND p.closed_at IS NULL LIMIT 1",
          [strategy.userId]
        );
        if (exits.length) return null;
      }
      const { rows: existing } = await tx.query(
        'SELECT id FROM options_live_batches WHERE strategy_id=$1 AND action_key=$2',
        [strategy.id, key]
      );
      if (existing.length) return null;
      const time = now();
      const { rows: [batch] } = await tx.query(
        `INSERT INTO options_live_batches
           (strategy_id,user_id,action_key,action,detail,created_at,deadline_at,auto_signal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [strategy.id, strategy.userId, key, action, detail || null, time, deadlineAt, autoSignalId ?? null]
      );
      // Todo cierre real queda con intención durable, aun si el LIMIT
      // termina parcialmente ejecutado. Evita que el protector vuelva a
      // colocar un TP sobre una posición que tiene un stop pendiente.
      if (action === 'close') {
        for (const leg of legs) {
          await tx.query(
            `INSERT INTO options_live_exit_requests
             (position_id,strategy_id,user_id,reason,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$5)
             ON CONFLICT (position_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
            [leg.positionId, strategy.id, strategy.userId, 'close_limit', time]
          );
        }
      }
      const orders = [];
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (!symbolOfStrategy(leg.symbol, current)) {
          throw new Error('Option symbol does not match strategy underlying');
        }
        const clientId = `HC${BigInt(batch.id).toString(36)}L${i.toString(36)}`;
        const { rows: [row] } = await tx.query(
          `INSERT INTO options_live_orders
            (batch_id,strategy_id,user_id,action,position_id,symbol,side,requested_qty,
             limit_price,client_order_id,created_at,deadline_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11) RETURNING *`,
          [batch.id, strategy.id, strategy.userId, action, leg.positionId ?? null,
            leg.symbol, leg.side, leg.quantity, leg.price, clientId, time, deadlineAt]
        );
        orders.push(map(row));
      }
      return orders;
    });
  }


  /**
   * Cada fill de apertura produce una posición individual: un TP por
   * position_id protege exactamente esa cantidad, incluso con fills parciales.
   * Nunca cubrir posiciones cuyo cierre ya fue solicitado.
   */

  /** Reversión de señal: guardar cierre + reentrada bajo UN advisory lock.
   * Nunca permitir que la nueva apertura corra antes de reconciliar el TP.
   */
  async function queueReversal(strategy, signal, closeAction) {
    const eventId = String(signal?.eventId ?? '');
    if (!/^\d{1,20}$/.test(eventId) ||
        !['bullish','bearish'].includes(signal.direction) ||
        closeAction.type !== 'close' || !closeAction.legs?.length) {
      throw new Error('Invalid durable reversal event');
    }
    return db.transaction(async (tx) => {
      const { rows: [owner] } = await tx.query(
        'SELECT id,user_id,mode,template FROM options_strategies WHERE id=$1 FOR UPDATE', [strategy.id]
      );
      if (!owner || Number(owner.user_id) !== Number(strategy.userId) ||
          owner.mode !== 'live' || owner.template !== 'alert_signal') return false;
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [strategy.userId]);
      const ids = closeAction.legs.map((l) => Number(l.positionId));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
          new Set(ids).size !== ids.length) throw new Error('Invalid reversal position ids');
      const { rows: held } = await tx.query(
        "SELECT id,user_id,strategy_id,symbol,side,quantity FROM options_strategy_positions " +
        "WHERE id=ANY($1::bigint[]) AND mode='live' AND closed_at IS NULL FOR UPDATE", [ids]
      );
      if (held.length !== ids.length) throw new Error('Reversal positions changed');
      const byId = new Map(held.map((p) => [Number(p.id), p]));
      for (const leg of closeAction.legs) {
        const p = byId.get(Number(leg.positionId));
        if (!p || Number(p.user_id) !== Number(strategy.userId) ||
            Number(p.strategy_id) !== Number(strategy.id) || p.side === leg.side ||
            p.symbol !== leg.symbol || !(Number(leg.quantity) > 0) ||
            Number(leg.quantity) > Number(p.quantity) + 1e-8) {
          throw new Error('Reversal may only close owned verified positions');
        }
      }
      const at = now();
      for (const p of held) {
        await tx.query(
          `INSERT INTO options_live_exit_requests
          (position_id,strategy_id,user_id,reason,created_at,updated_at)
          VALUES ($1,$2,$3,'opposite_signal',$4,$4)
          ON CONFLICT (position_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
          [p.id, strategy.id, strategy.userId, at]
        );
      }
      await tx.query(
        "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$2 " +
        "WHERE user_id=$1 AND status<>'final' AND " +
        "((purpose='take_profit' AND position_id=ANY($3::bigint[])) " +
        "OR (action='open' AND symbol=ANY($4::text[])))",
        [strategy.userId, at, ids, held.map((p) => p.symbol)]
      );
      // La misma señal ya en cola como reevaluación (entradas canceladas) se
      // convierte en reentrada: conserva su created_at (caducidad desde la
      // señal original) y espera ahora al cierre de estas posiciones.
      const savedSignal = {
        eventId,
        direction: signal.direction,
        // Bot multi-subyacente: la reentrada abre en el subyacente que giró.
        underlying: signal.underlying ?? null,
        // Fila de la señal: la entrada diferida la enlaza y se resuelve con sus fills.
        ...signalIdOf(signal),
      };
      await tx.query(
        `INSERT INTO options_live_reentries
         (strategy_id,user_id,alert_event_id,signal,wait_position_ids,created_at,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::bigint[],$6,$6)
         ON CONFLICT (strategy_id,alert_event_id) DO UPDATE SET kind='reentry',
           wait_position_ids=EXCLUDED.wait_position_ids,wait_order_ids='{}'::bigint[],
           signal=EXCLUDED.signal,updated_at=EXCLUDED.updated_at
         WHERE options_live_reentries.kind='reevaluate' AND options_live_reentries.status='pending'`,
        [strategy.id, strategy.userId, eventId, JSON.stringify(savedSignal), ids, at]
      );
      return true;
    });
  }

  /**
   * Señal contraria con entradas reales pendientes: se piden sus
   * cancelaciones y la señal espera, durable, a que TODAS esas órdenes sean
   * finales para volver a evaluarse. Mismas comprobaciones que queueReversal.
   * Devuelve false si el bot ya no es real/por alertas del usuario.
   */
  async function queueSignalReevaluation(strategy, signal, orderIds) {
    const eventId = String(signal?.eventId ?? '');
    const ids = Array.isArray(orderIds) ? orderIds.map(Number) : null;
    if (!/^\d{1,20}$/.test(eventId) || !['bullish','bearish'].includes(signal?.direction) ||
        !ids || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(ids).size !== ids.length) {
      throw new Error('Invalid durable reevaluation event');
    }
    return db.transaction(async (tx) => {
      const { rows: [owner] } = await tx.query(
        'SELECT id,user_id,mode,template FROM options_strategies WHERE id=$1 FOR UPDATE', [strategy.id]
      );
      if (!owner || Number(owner.user_id) !== Number(strategy.userId) ||
          owner.mode !== 'live' || owner.template !== 'alert_signal') return false;
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [strategy.userId]);
      if (ids.length) {
        const { rows: owned } = await tx.query(
          "SELECT id FROM options_live_orders WHERE id=ANY($1::bigint[]) AND user_id=$2 " +
          "AND strategy_id=$3 AND action='open' FOR UPDATE", [ids, strategy.userId, strategy.id]
        );
        if (owned.length !== ids.length) throw new Error('Reevaluation orders do not belong to this strategy');
      }
      const savedSignal = {
        eventId,
        direction: signal.direction,
        underlying: signal.underlying ?? null,
        ...signalIdOf(signal),
      };
      await tx.query(
        `INSERT INTO options_live_reentries
         (strategy_id,user_id,alert_event_id,signal,wait_position_ids,kind,wait_order_ids,created_at,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,'{}'::bigint[],'reevaluate',$5::bigint[],$6,$6)
         ON CONFLICT (strategy_id,alert_event_id) DO NOTHING`,
        [strategy.id, strategy.userId, eventId, JSON.stringify(savedSignal), ids, now()]
      );
      return true;
    });
  }

  /**
   * Cola de reentradas pendientes. `ready`: para 'reentry', las posiciones
   * de espera están cerradas; para 'reevaluate', ninguna orden de espera
   * sigue sin ser final.
   */
  async function listPendingReentries(limit = 50) {
    const { rows } = await db.query(
      "SELECT r.id,r.strategy_id,r.user_id,r.alert_event_id,r.signal,r.created_at,r.kind,r.wait_order_ids, " +
      "CASE WHEN r.kind='reevaluate' THEN NOT EXISTS (SELECT 1 FROM options_live_orders o " +
      "WHERE o.id=ANY(r.wait_order_ids) AND o.status<>'final') " +
      "ELSE NOT EXISTS (SELECT 1 FROM options_strategy_positions p " +
      "WHERE p.id=ANY(r.wait_position_ids) AND p.closed_at IS NULL) END AS ready " +
      "FROM options_live_reentries r JOIN options_strategies s ON s.id=r.strategy_id " +
      "WHERE r.status='pending' AND s.mode='live' " +
      "ORDER BY r.created_at,r.id LIMIT $1", [limit]
    );
    return rows.map((r) => ({
      id: Number(r.id), strategyId: Number(r.strategy_id), userId: Number(r.user_id),
      eventId: String(r.alert_event_id), signal: typeof r.signal === 'string' ? JSON.parse(r.signal) : r.signal,
      createdAt: Number(r.created_at), ready: r.ready === true,
      kind: r.kind || 'reentry', waitOrderIds: (r.wait_order_ids || []).map(Number),
    }));
  }

  async function hasReentryOrder(strategyId, eventId) {
    const { rows } = await db.query(
      "SELECT id FROM options_live_batches WHERE strategy_id=$1 AND action_key=$2 LIMIT 1",
      [strategyId, 'alert:' + eventId + ':open']
    );
    return rows.length > 0;
  }

  async function markReentry(id, status) {
    if (!['submitted','expired'].includes(status)) throw new Error('Invalid reentry status');
    const { rowCount } = await db.query(
      "UPDATE options_live_reentries SET status=$2,updated_at=$3 WHERE id=$1 AND status='pending'",
      [id, status, now()]
    );
    return rowCount === 1;
  }

  async function listMissingTpPositions(limit = 100) {
    const { rows } = await db.query(
      "SELECT p.id,p.strategy_id,p.user_id,p.symbol,p.side,p.quantity,p.entry_price," +
      "p.tp_target_price,p.tp_target_meta," +
      "s.params,s.underlying FROM options_strategy_positions p " +
      "JOIN options_strategies s ON s.id=p.strategy_id " +
      "WHERE p.mode='live' AND p.closed_at IS NULL AND p.quantity > 0 " +
      "AND s.mode='live' AND s.template='alert_signal' " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o " +
      "WHERE o.position_id=p.id AND o.purpose='take_profit' AND o.status<>'final') " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_exit_requests r WHERE r.position_id=p.id) " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o " +
      "WHERE o.position_id=p.id AND o.action='close' AND o.status<>'final') " +
      "ORDER BY p.id DESC LIMIT $1", [limit]
    );
    return rows.map((p) => ({
      id: Number(p.id), strategyId: Number(p.strategy_id), userId: Number(p.user_id),
      symbol: p.symbol, side: p.side, quantity: Number(p.quantity),
      entryPrice: Number(p.entry_price),
      params: typeof p.params === 'string' ? JSON.parse(p.params) : p.params,
      underlying: p.underlying,
      tpTargetPrice: p.tp_target_price == null ? null : Number(p.tp_target_price),
      tpTargetMeta: typeof p.tp_target_meta === 'string' ? JSON.parse(p.tp_target_meta) : (p.tp_target_meta ?? null),
    }));
  }

  /** Un único TP activo por fill, registrado DURABLEMENTE antes del POST. */
  async function beginStandingTp({ position, price, deadlineAt }) {
    return db.transaction(async (tx) => {
      const { rows: [strategy] } = await tx.query(
        "SELECT id,user_id,mode,template,underlying,params FROM options_strategies WHERE id=$1 FOR UPDATE",
        [position.strategyId]
      );
      if (!strategy || Number(strategy.user_id) !== position.userId ||
          strategy.mode !== 'live' || strategy.template !== 'alert_signal') return null;
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [position.userId]);
      const { rows: [held] } = await tx.query(
        "SELECT * FROM options_strategy_positions WHERE id=$1 AND closed_at IS NULL FOR UPDATE",
        [position.id]
      );
      if (!held || held.mode !== 'live' ||
          Number(held.user_id) !== position.userId ||
          Number(held.strategy_id) !== position.strategyId ||
          held.symbol !== position.symbol || held.side !== position.side ||
          Math.abs(Number(held.quantity) - position.quantity) > 1e-8 ||
          !symbolOfStrategy(position.symbol, strategy)) return null;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(deadlineAt) || deadlineAt <= now()) {
        throw new Error('Invalid standing TP limit price or expiration');
      }
      const { rows: blocked } = await tx.query(
        "SELECT id FROM options_live_orders WHERE position_id=$1 AND status<>'final' " +
        "AND (purpose='take_profit' OR action='close') " +
        "UNION ALL SELECT id FROM options_live_exit_requests WHERE position_id=$1 LIMIT 1",
        [position.id]
      );
      if (blocked.length) return null;
      const { rows: [{ n }] } = await tx.query(
        "SELECT COUNT(*)::int AS n FROM options_live_orders " +
        "WHERE position_id=$1 AND purpose='take_profit'", [position.id]
      );
      const actionKey = 'tp:' + position.id + ':' + n;
      const time = now();
      const { rows: [batch] } = await tx.query(
        `INSERT INTO options_live_batches
           (strategy_id,user_id,action_key,action,detail,created_at,deadline_at)
         VALUES ($1,$2,$3,'close',$4,$5,$6) RETURNING id`,
        [position.strategyId, position.userId, actionKey,
          'TP LIMIT al fill confirmado (reduceOnly)', time, deadlineAt]
      );
      const id = 'HC' + BigInt(batch.id).toString(36) + 'T0';
      const side = held.side === 'BUY' ? 'SELL' : 'BUY';
      const { rows: [order] } = await tx.query(
        `INSERT INTO options_live_orders
         (batch_id,strategy_id,user_id,action,position_id,symbol,side,
          requested_qty,limit_price,client_order_id,created_at,deadline_at,updated_at,purpose)
         VALUES ($1,$2,$3,'close',$4,$5,$6,$7,$8,$9,$10,$11,$10,'take_profit') RETURNING *`,
        [batch.id, position.strategyId, position.userId, position.id,
          position.symbol, side, position.quantity, price, id, time, deadlineAt]
      );
      return map(order);
    });
  }

  /**
   * Watchdog SOLO LECTURA: detecta fills registrados que llevan demasiado
   * tiempo abiertos sin TP activo y confirmado. queued/sending/attention
   * y cancelaciones solicitadas no equivalen a protección en Binance.
   */
  async function listUnprotectedLivePositions(olderThan, limit = 100) {
    const { rows } = await db.query(
      "SELECT p.id,p.user_id,p.strategy_id,p.opened_at,p.symbol,s.params FROM options_strategy_positions p " +
      "JOIN options_strategies s ON s.id=p.strategy_id " +
      "WHERE p.mode='live' AND p.closed_at IS NULL AND p.quantity > 0 " +
      "AND s.mode='live' AND s.template='alert_signal' AND p.opened_at <= $1 " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o " +
      "WHERE o.position_id=p.id AND o.purpose='take_profit' " +
      "AND o.status='active' AND o.cancel_requested=FALSE) " +
      "ORDER BY p.opened_at,p.id LIMIT $2",
      [olderThan, limit]
    );
    return rows.map((r) => ({
      positionId: Number(r.id), userId: Number(r.user_id),
      strategyId: Number(r.strategy_id), openedAt: Number(r.opened_at),
      symbol: r.symbol,
      params: typeof r.params === 'string' ? JSON.parse(r.params) : (r.params ?? null),
    }));
  }

  async function listQueuedTpOrders(limit = 100) {
    const { rows } = await db.query(
      "SELECT * FROM options_live_orders WHERE status='queued' AND purpose='take_profit' " +
      "AND NOT cancel_requested ORDER BY created_at,id LIMIT $1", [limit]
    );
    return rows.map(map);
  }

  /** Una solicitud de salida no se pierde durante la cancelación del TP. */
  async function deferExitIfProtected(strategy, action) {
    if (action.type !== 'close' || !Array.isArray(action.legs) || !action.legs.length) return false;
    return db.transaction(async (tx) => {
      const { rows: [owner] } = await tx.query(
        'SELECT id,user_id,mode FROM options_strategies WHERE id=$1 FOR UPDATE', [strategy.id]
      );
      if (!owner || Number(owner.user_id) !== Number(strategy.userId) || owner.mode !== 'live') {
        throw new Error('Strategy no longer live');
      }
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [strategy.userId]);
      const ids = action.legs.map((l) => Number(l.positionId));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
          new Set(ids).size !== ids.length) throw new Error('Invalid exit position ids');
      const { rows: held } = await tx.query(
        'SELECT id,user_id,strategy_id,symbol,side,quantity FROM options_strategy_positions ' +
        'WHERE id=ANY($1::bigint[]) AND mode=\'live\' AND closed_at IS NULL FOR UPDATE', [ids]
      );
      if (held.length !== ids.length) throw new Error('Exit position no longer open');
      const byId = new Map(held.map((p) => [Number(p.id), p]));
      for (const leg of action.legs) {
        const p = byId.get(Number(leg.positionId));
        if (!p || Number(p.user_id) !== Number(strategy.userId) ||
            Number(p.strategy_id) !== Number(strategy.id) ||
            p.symbol !== leg.symbol || p.side === leg.side ||
            Number(leg.quantity) > Number(p.quantity) + 1e-8) {
          throw new Error('Exit leg does not match verified position');
        }
      }
      const { rows: protectedOrders } = await tx.query(
        "SELECT id FROM options_live_orders WHERE user_id=$1 AND status<>'final' " +
        "AND ((purpose='take_profit' AND position_id=ANY($2::bigint[])) " +
        "OR (action='open' AND symbol=ANY($3::text[]))) LIMIT 1",
        [strategy.userId, ids, held.map((p) => p.symbol)]
      );
      if (!protectedOrders.length) return false;
      const time = now();
      for (const p of held) {
        await tx.query(
          `INSERT INTO options_live_exit_requests
           (position_id,strategy_id,user_id,reason,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$5)
           ON CONFLICT (position_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
          [p.id, strategy.id, strategy.userId, String(action.reason || 'exit').slice(0, 80), time]
        );
      }
      await tx.query(
        "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$2 " +
        "WHERE user_id=$1 AND status<>'final' AND " +
        "((purpose='take_profit' AND position_id=ANY($3::bigint[])) " +
        "OR (action='open' AND symbol=ANY($4::text[])))",
        [strategy.userId, time, ids, held.map((p) => p.symbol)]
      );
      return true;
    });
  }

  /** El plazo del TP obliga a dejar constancia de una salida por tiempo,
   * incluso si falla la lectura de la cadena de opciones del runner.
   * Excepción: en 'atr_band' no hay salida por tiempo (se mantiene hasta la
   * liquidación); el TP se cancela en su plazo pero no se pide cierre.
   */
  async function requestDeadlineExit(order) {
    if (order.purpose !== 'take_profit') return false;
    return db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [order.userId]);
      const { rows: [held] } = await tx.query(
        "SELECT p.id,p.user_id,p.strategy_id,p.symbol,s.params FROM options_strategy_positions p " +
        "JOIN options_strategies s ON s.id=p.strategy_id " +
        "WHERE p.id=$1 AND p.mode='live' AND p.closed_at IS NULL FOR UPDATE OF p", [order.positionId]
      );
      if (!held) return false;
      const params = typeof held.params === 'string' ? JSON.parse(held.params) : held.params;
      if (params?.takeProfitMode === 'atr_band') return false;
      if (Number(held.user_id) !== order.userId ||
          Number(held.strategy_id) !== order.strategyId ||
          held.symbol !== order.symbol) {
        throw new Error('Standing TP expired for an unrelated position');
      }
      const at = now();
      await tx.query(
        `INSERT INTO options_live_exit_requests
         (position_id,strategy_id,user_id,reason,created_at,updated_at)
         VALUES ($1,$2,$3,'time_exit',$4,$4)
         ON CONFLICT(position_id) DO UPDATE SET updated_at=EXCLUDED.updated_at`,
        [held.id, order.strategyId, order.userId, at]
      );
      await tx.query(
        "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$2 " +
        "WHERE id=$1 AND purpose='take_profit' AND status<>'final'",
        [order.id, at]
      );
      return true;
    });
  }

  async function listReadyExitRequests(limit = 100) {
    const { rows } = await db.query(
      "SELECT r.id,p.id AS position_id,p.strategy_id,p.user_id,p.symbol,p.side,p.quantity " +
      "FROM options_live_exit_requests r " +
      "JOIN options_strategy_positions p ON p.id=r.position_id " +
      "JOIN options_strategies s ON s.id=p.strategy_id " +
      "WHERE p.closed_at IS NULL AND p.mode='live' AND s.mode='live' " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o WHERE o.position_id=p.id " +
      "AND o.purpose='take_profit' AND o.status<>'final') " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o WHERE o.user_id=p.user_id " +
      "AND o.action='open' AND o.symbol=p.symbol AND o.status<>'final') " +
      "AND NOT EXISTS (SELECT 1 FROM options_live_orders o WHERE o.position_id=p.id " +
      "AND o.action='close' AND o.purpose='standard' AND o.status<>'final') " +
      "ORDER BY r.created_at,r.id LIMIT $1", [limit]
    );
    return rows.map((p) => ({
      id: Number(p.id), positionId: Number(p.position_id),
      strategyId: Number(p.strategy_id), userId: Number(p.user_id),
      symbol: p.symbol, side: p.side, quantity: Number(p.quantity),
    }));
  }

  async function hasStandingTp(positionIds) {
    if (!Array.isArray(positionIds) || !positionIds.length) return false;
    const ids = positionIds.map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('Invalid TP position id');
    }
    const { rows } = await db.query(
      "SELECT id FROM options_live_orders WHERE position_id=ANY($1::bigint[]) " +
      "AND purpose='take_profit' AND status<>'final' LIMIT 1", [ids]
    );
    return rows.length > 0;
  }

  /**
   * Cancelación pedida desde la UI: solo una ENTRADA del propio bot y
   * usuario, no final. Las salidas (incluido el TP residente) no se cancelan:
   * se reintentan solas. El reconciliador hace la cancelación en Binance.
   */
  async function requestCancel({ userId, strategyId, orderId }) {
    const ids = [orderId, userId, strategyId].map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid cancel request');
    const { rows } = await db.query(
      "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$4 " +
      "WHERE id=$1 AND user_id=$2 AND strategy_id=$3 AND status<>'final' " +
      "AND purpose<>'take_profit' AND action='open' RETURNING *",
      [ids[0], ids[1], ids[2], now()]
    );
    return rows[0] ? map(rows[0]) : null;
  }

  /**
   * Señal contraria: pide cancelar TODAS las entradas no finales del bot en
   * el subyacente (también las que ya tenían la cancelación pedida, que
   * igualmente hay que esperar). Devuelve sus ids.
   */
  async function requestCancelEntries({ userId, strategyId, underlying }) {
    const ids = [userId, strategyId].map(Number);
    const u = String(underlying ?? '').trim().toUpperCase();
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || !/^[A-Z0-9]{1,20}$/.test(u)) {
      throw new Error('Invalid cancel entries request');
    }
    const { rows } = await db.query(
      "UPDATE options_live_orders SET cancel_requested=TRUE,updated_at=$4 " +
      "WHERE user_id=$1 AND strategy_id=$2 AND action='open' AND purpose<>'take_profit' " +
      "AND status<>'final' AND symbol LIKE $3 RETURNING id",
      [ids[0], ids[1], u + '-%', now()]
    );
    return rows.map((r) => Number(r.id));
  }

  /**
   * Resultado de un lote de entrada a partir de los fills conciliados:
   * cantidad pedida y ejecutada, precio medio ponderado y comisiones.
   */
  async function batchEntryOutcome(batchId) {
    return entryOutcomeWith(db, batchId);
  }

  // Mismo cálculo dentro de la transacción de finishOrder (q = db o tx).
  async function entryOutcomeWith(q, batchId) {
    const { rows: orders } = await q.query(
      "SELECT b.id,b.auto_signal_id,o.id AS order_id,o.symbol,o.side,o.requested_qty," +
      "o.cancel_requested,o.last_error " +
      "FROM options_live_batches b JOIN options_live_orders o ON o.batch_id=b.id " +
      "WHERE b.id=$1 AND b.action='open' ORDER BY o.id", [batchId]
    );
    if (!orders.length) return null;
    const { rows: fills } = await q.query(
      "SELECT f.quantity,f.price,f.fee_usdt FROM options_live_fills f " +
      "JOIN options_live_orders o ON o.id=f.live_order_id WHERE o.batch_id=$1 ORDER BY f.id", [batchId]
    );
    const round = (x) => Number(x.toFixed(12));
    let filled = 0;
    let notional = 0;
    let fees = 0;
    for (const f of fills) {
      filled += Number(f.quantity);
      notional += Number(f.quantity) * Number(f.price);
      fees += Number(f.fee_usdt || 0);
    }
    return {
      autoSignalId: orders[0].auto_signal_id == null ? null : Number(orders[0].auto_signal_id),
      requested: round(orders.reduce((acc, o) => acc + Number(o.requested_qty), 0)),
      filled: round(filled),
      avgPrice: filled > 0 ? round(notional / filled) : null,
      feesUsdt: round(fees),
      symbol: orders[0].symbol,
      side: orders[0].side,
      cancelRequested: orders.some((o) => o.cancel_requested === true),
      // markRejected deja este prefijo: Binance rechazó el envío sin crear la orden.
      rejected: orders.some((o) => /^Rechazada por Binance/.test(String(o.last_error || ''))),
    };
  }

  /**
   * ¿Hay ya un cierre real en curso (orden de cierre no final que no sea el
   * TP, o salida diferida persistida) en alguna posición abierta objetivo?
   * Sin positionIds se miran todas las posiciones reales abiertas del bot.
   */
  async function hasPendingClose({ userId, strategyId, positionIds = null }) {
    const ids = Array.isArray(positionIds) ? positionIds.map(Number) : null;
    const { rows } = await db.query(
      "SELECT p.id FROM options_strategy_positions p " +
      "WHERE p.user_id=$1 AND p.strategy_id=$2 AND p.mode='live' AND p.closed_at IS NULL " +
      "AND ($3::bigint[] IS NULL OR p.id=ANY($3::bigint[])) " +
      "AND (EXISTS (SELECT 1 FROM options_live_orders o WHERE o.position_id=p.id " +
      "AND o.action='close' AND o.purpose<>'take_profit' AND o.status<>'final') " +
      "OR EXISTS (SELECT 1 FROM options_live_exit_requests r WHERE r.position_id=p.id)) LIMIT 1",
      [Number(userId), Number(strategyId), ids]
    );
    return rows.length > 0;
  }

  async function listRestingTpOrderIds(userId) {
    const { rows } = await db.query(
      "SELECT client_order_id,exchange_order_id FROM options_live_orders " +
      "WHERE user_id=$1 AND purpose='take_profit' AND status<>'final'", [userId]
    );
    return rows.map((r) => ({ clientOrderId: r.client_order_id, orderId: r.exchange_order_id }));
  }

  async function listUnresolved() {
    const { rows } = await db.query(
      "SELECT * FROM options_live_orders WHERE status <> 'final' " +
      "AND (status <> 'queued' OR deadline_at <= $1 OR cancel_requested) ORDER BY created_at,id",
      [now()]
    );
    return rows.map(map);
  }

  async function listByStrategy(strategyId) {
    const { rows } = await db.query(
      'SELECT * FROM options_live_orders WHERE strategy_id=$1 ORDER BY id DESC', [strategyId]
    );
    return rows.map(map);
  }

  async function listMonitorUsers(limit = 50) {
    const { rows } = await db.query(
      "SELECT user_id FROM (SELECT user_id FROM options_strategies WHERE mode='live' " +
      "UNION SELECT user_id FROM options_live_orders WHERE status<>'final') users " +
      "ORDER BY user_id LIMIT $1",
      [limit]
    );
    return rows.map((r) => Number(r.user_id));
  }

  async function listUserOrderIds(userId, since = now() - 90 * 24 * 60 * 60_000) {
    const { rows } = await db.query(
      "SELECT client_order_id,status FROM options_live_orders " +
      "WHERE user_id=$1 AND created_at >= $2",
      [userId, since]
    );
    return rows.map((r) => ({ clientOrderId: r.client_order_id, status: r.status }));
  }

  async function claimIncidentNotification(userId, kind, resource, intervalMs = 15 * 60_000) {
    const time = now();
    const { rows } = await db.query(
      "INSERT INTO options_live_incident_notifications " +
      "(user_id,incident_kind,resource,last_notified_at) VALUES ($1,$2,$3,$4) " +
      "ON CONFLICT (user_id,incident_kind,resource) DO UPDATE " +
      "SET last_notified_at=EXCLUDED.last_notified_at " +
      "WHERE options_live_incident_notifications.last_notified_at <= $5 RETURNING user_id",
      [userId, kind, resource, time, time - intervalMs]
    );
    return rows.length > 0;
  }

  /**
   * Claim a critical incident alert with the exact timestamp used in the DB.
   * Caller must release this token if Telegram delivery fails. The legacy
   * boolean claim API above remains for older callers.
   */
  async function claimIncidentNotificationToken(userId, kind, resource, intervalMs = 15 * 60_000) {
    const time = now();
    const { rows } = await db.query(
      "INSERT INTO options_live_incident_notifications " +
      "(user_id,incident_kind,resource,last_notified_at) VALUES ($1,$2,$3,$4) " +
      "ON CONFLICT (user_id,incident_kind,resource) DO UPDATE " +
      "SET last_notified_at=EXCLUDED.last_notified_at " +
      "WHERE options_live_incident_notifications.last_notified_at <= $5 " +
      "RETURNING last_notified_at",
      [userId, kind, resource, time, time - intervalMs]
    );
    return rows.length ? Number(rows[0].last_notified_at) : null;
  }

  /**
   * Only release this worker's failed delivery attempt; a concurrent
   * successful alert or another newer claim must never be reset.
   */
  async function releaseIncidentNotification(userId, kind, resource, claimAt) {
    if (!Number.isSafeInteger(Number(claimAt)) || Number(claimAt) <= 0) {
      throw new Error('Invalid incident notification token');
    }
    const { rows } = await db.query(
      "UPDATE options_live_incident_notifications SET last_notified_at=0 " +
      "WHERE user_id=$1 AND incident_kind=$2 AND resource=$3 " +
      "AND last_notified_at=$4 RETURNING user_id",
      [userId, kind, resource, claimAt]
    );
    return rows.length > 0;
  }

  /** Alertas operativas: reclamar envío a Telegram a lo sumo 1/15 minutos.
   * Es atómico entre réplicas, persiste tras reinicios, no contiene secretos.
   */
  async function claimAttentionNotification(id, intervalMs = 15 * 60_000) {
    const time = now();
    const { rows } = await db.query(
      "UPDATE options_live_orders SET attention_notified_at=$2 WHERE id=$1 " +
      "AND status='attention' AND attention_notified_at <= $3 " +
      "RETURNING id,user_id,strategy_id,symbol,client_order_id,last_error,deadline_at,attention_notified_at",
      [id, time, time - intervalMs]
    );
    return rows[0] || null;
  }

  /** Return an alert claim to the queue when Telegram delivery failed.
   * Compare the claimed timestamp to avoid undoing a newer replica claim.
   * Only an attention order can be released; this never changes its status.
   */
  async function releaseAttentionNotification(id, claimAt) {
    if (!Number.isSafeInteger(Number(id)) || !(Number(id) > 0) ||
        !Number.isSafeInteger(Number(claimAt)) || !(Number(claimAt) > 0)) {
      throw new Error('Invalid attention alert release token');
    }
    const { rows } = await db.query(
      "UPDATE options_live_orders SET attention_notified_at=0 " +
      "WHERE id=$1 AND status='attention' AND attention_notified_at=$2 RETURNING id",
      [id, claimAt]
    );
    return rows.length > 0;
  }

  async function listAttentionOrders(limit = 100) {
    const { rows } = await db.query(
      "SELECT id FROM options_live_orders WHERE status='attention' " +
      "ORDER BY updated_at,id LIMIT $1",
      [limit]
    );
    return rows.map((row) => Number(row.id));
  }

  async function countSubmittedSince(strategyId, since) {
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM options_live_orders WHERE strategy_id=$1 AND created_at >= $2 AND status <> 'queued'",
      [strategyId, since]
    );
    return Number(rows[0]?.n || 0);
  }

  async function markSending(id) {
    const { rows } = await db.query(
      "UPDATE options_live_orders SET status='sending',updated_at=$2 WHERE id=$1 " +
      "AND status='queued' AND NOT cancel_requested AND deadline_at > $2 AND reconcile_lease_until < $2 RETURNING *",
      [id, now()]
    );
    return rows[0] ? map(rows[0]) : null;
  }

  async function markActive(id, orderId) {
    const { rowCount } = await db.query(
      `UPDATE options_live_orders SET status='active',
        exchange_order_id=COALESCE(exchange_order_id,$2),updated_at=$3
       WHERE id=$1 AND status IN ('sending','active','attention')
         AND (exchange_order_id IS NULL OR exchange_order_id=$2)`,
      [id, orderId == null ? null : String(orderId), now()]
    );
    if (rowCount !== 1) throw new Error('Live order identity conflict or finalized order');
  }

  async function markAttention(id, error) {
    await db.query(
      "UPDATE options_live_orders SET status='attention',last_error=$2,updated_at=$3 WHERE id=$1 AND status<>'final'",
      [id, String(error).slice(0, 1000), now()]
    );
    await db.query(
      "UPDATE options_live_batches SET status='attention' WHERE id=(SELECT batch_id FROM options_live_orders WHERE id=$1) AND status<>'completed'",
      [id]
    );
  }

  /**
   * Binance rechazó el envío sin crear la orden: volver a 'queued' con
   * cancelación pedida para que el reconciliador la finalice a cero.
   */
  async function markRejected(id, error) {
    const { rowCount } = await db.query(
      `UPDATE options_live_orders SET status='queued',cancel_requested=TRUE,last_error=$2,updated_at=$3
       WHERE id=$1 AND status='sending' AND exchange_order_id IS NULL AND processed_qty=0`,
      [id, String(error).slice(0, 1000), now()]
    );
    return rowCount === 1;
  }

  async function claimReconcile(id, leaseMs = 300_000) {
    const time = now();
    const { rows } = await db.query(
      `UPDATE options_live_orders SET reconcile_lease_until=$2
       WHERE id=$1 AND status <> 'final' AND reconcile_lease_until < $3 RETURNING *`,
      [id, time + leaseMs, time]
    );
    return rows[0] ? map(rows[0]) : null;
  }

  async function releaseReconcile(id, leaseUntil) {
    // No liberar el lease de otra réplica que lo haya renovado tras caducar.
    if (!Number.isFinite(Number(leaseUntil)) || Number(leaseUntil) <= 0) return false;
    const { rowCount } = await db.query(
      'UPDATE options_live_orders SET reconcile_lease_until=0 WHERE id=$1 AND reconcile_lease_until=$2',
      [id, leaseUntil]
    );
    return rowCount === 1;
  }

  /** Transacción única para el fill, la posición y el evento. */
  async function applyTrade(order, trade) {
    return db.transaction(async (tx) => {
      const { rows: [locked] } = await tx.query(
        'SELECT * FROM options_live_orders WHERE id=$1 FOR UPDATE', [order.id]
      );
      if (!locked) throw new Error('Missing order');
      // La conciliación modifica la exposición y debe compartir el lock de
      // usuario con beginBatch para que no pasen snapshots inconsistentes.
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [locked.user_id]);
      const { rows: [fill] } = await tx.query(
        `INSERT INTO options_live_fills
          (live_order_id,trade_id,quantity,price,fee_usdt,traded_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (live_order_id,trade_id) DO NOTHING RETURNING id`,
        [order.id, trade.id, trade.quantity, trade.price, trade.fee, trade.at]
      );
      if (!fill) return false;
      const quantity = Number(trade.quantity);
      if (!(quantity > 0) || quantity + Number(locked.processed_qty) > Number(locked.requested_qty) + 1e-9) {
        throw new Error('Fill exceeds order quantity');
      }
      if (locked.action === 'open') {
        await tx.query(
          `INSERT INTO options_strategy_positions
           (strategy_id,user_id,mode,symbol,side,quantity,entry_price,opened_at,fees_usdt,entry_fee_usdt)
           VALUES ($1,$2,'live',$3,$4,$5,$6,$7,$8,$9)`,
          [locked.strategy_id, locked.user_id, locked.symbol, locked.side,
            quantity, trade.price, trade.at, trade.fee, trade.fee]
        );
      } else {
        const { rows: [position] } = await tx.query(
          'SELECT * FROM options_strategy_positions WHERE id=$1 AND closed_at IS NULL FOR UPDATE',
          [locked.position_id]
        );
        if (!position) throw new Error('Position missing/already closed: manual reconciliation required');
        if (Number(position.strategy_id) !== Number(locked.strategy_id) ||
            Number(position.user_id) !== Number(locked.user_id) ||
            position.symbol !== locked.symbol ||
            position.side === locked.side ||
            position.mode !== 'live') {
          throw new Error('Live close order does not belong to the target position');
        }
        // Solo se conoce el motivo cuando la orden es el TP; el resto queda NULL.
        const closeReason = locked.purpose === 'take_profit' ? 'take_profit' : null;
        const held = Number(position.quantity);
        if (quantity > held + 1e-9) throw new Error('Fill larger than open position');
        // Una abierta solo ha pagado la entrada (fees_usdt = entry_fee_usdt):
        // se reparte en proporción a la cantidad cerrada, y ambas filas
        // conservan fees_usdt = entrada + salida.
        const allocatedEntryFee = Number(position.fees_usdt) * (quantity / held);
        const fees = allocatedEntryFee + trade.fee;
        const pnl = grossPnl({ side: position.side, entryPrice: position.entry_price,
          exitPrice: trade.price, quantity }) - fees;
        if (Math.abs(held - quantity) < 1e-9) {
          await tx.query(
            `UPDATE options_strategy_positions
             SET exit_price=$2,closed_at=$3,pnl_usdt=$4,fees_usdt=$5,close_reason=$6,
                 entry_fee_usdt=$7,exit_fee_usdt=$8 WHERE id=$1`,
            [position.id, trade.price, trade.at, pnl, fees, closeReason, allocatedEntryFee, trade.fee]
          );
        } else {
          await tx.query(
            'UPDATE options_strategy_positions SET quantity=$2,fees_usdt=$3,entry_fee_usdt=$3 WHERE id=$1',
            [position.id, held - quantity, Number(position.fees_usdt) - allocatedEntryFee]
          );
          await tx.query(
            `INSERT INTO options_strategy_positions
             (strategy_id,user_id,mode,symbol,side,quantity,entry_price,exit_price,
              opened_at,closed_at,pnl_usdt,fees_usdt,close_reason,entry_fee_usdt,exit_fee_usdt)
             VALUES ($1,$2,'live',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [position.strategy_id, position.user_id, position.symbol, position.side, quantity,
              position.entry_price, trade.price, position.opened_at, trade.at, pnl, fees, closeReason,
              allocatedEntryFee, trade.fee]
          );
        }
      }
      await tx.query('UPDATE options_live_orders SET processed_qty=processed_qty+$2,updated_at=$3 WHERE id=$1',
        [order.id, quantity, now()]);
      await tx.query(
        `INSERT INTO options_strategy_events
         (strategy_id,user_id,mode,action,detail,legs,premium_usdt,created_at)
         VALUES ($1,$2,'live',$3,$4,$5,$6,$7)`,
        [locked.strategy_id, locked.user_id, locked.action,
          'Fill verificado por Binance (trade ' + trade.id + ')',
          JSON.stringify([{ symbol: locked.symbol, side: locked.side, quantity,
            price: trade.price, fee: trade.fee, orderId: locked.exchange_order_id,
            tradeId: trade.id }]),
          signedPremium(locked.side, trade.price, quantity), trade.at]
      );
      return true;
    });
  }

  /**
   * Finaliza una orden. En la MISMA transacción, opcionalmente:
   * - `block` `{ underlying, reason, at }`: bloquea el subyacente del bot
   *   (resto de entrada no operable), misma fusión jsonb que setUnderlyingBlock;
   * - `resolveSignal(outcome) → { decision, detail, feesUsdt, feesEstimated }`:
   *   si el lote de ENTRADA queda completo y enlazado a una señal, la resuelve
   *   con los fills reales. Un fallo deshace también la finalización, así que
   *   la siguiente pasada lo reintenta todo: nunca se pierde el bloqueo.
   */
  async function finishOrder(id, exchangeOrderId, executedQuantity, { block = null, resolveSignal = null } = {}) {
    if (block) {
      const u = String(block.underlying ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,20}$/.test(u) || !block.reason) throw new Error('Invalid underlying block');
      block = { ...block, underlying: u };
    }
    return db.transaction(async (tx) => {
      const { rows: [locked] } = await tx.query(
        'SELECT * FROM options_live_orders WHERE id=$1 FOR UPDATE', [id]
      );
      if (!locked || locked.status === 'final') return null;
      // Sin identificador del exchange, solo puede finalizar una orden
      // que sigue en cola y nunca pasó por el estado sending.
      if (exchangeOrderId == null && locked.status !== 'queued') {
        throw new Error('Cannot finalize possibly submitted order without Binance identity');
      }
      if (Math.abs(Number(locked.processed_qty) - Number(executedQuantity)) > 1e-8) {
        throw new Error('Execution and trade ledger quantities differ');
      }
      await tx.query(
        `UPDATE options_live_orders SET status='final',
         exchange_order_id=COALESCE($2,exchange_order_id),updated_at=$3,reconcile_lease_until=0
         WHERE id=$1`, [id, exchangeOrderId == null ? null : String(exchangeOrderId), now()]
      );
      if (block) {
        const { rowCount } = await tx.query(
          `UPDATE options_strategies
              SET state = jsonb_set(
                    COALESCE(state, '{}'::jsonb), '{blockedUnderlyings}',
                    CASE WHEN jsonb_typeof(state->'blockedUnderlyings') = 'object'
                         THEN state->'blockedUnderlyings' ELSE '{}'::jsonb END
                      || jsonb_build_object($2::text, jsonb_build_object('reason', $3::text, 'at', $4::bigint)),
                    true)
            WHERE id = $1`,
          [locked.strategy_id, block.underlying, String(block.reason), block.at ?? now()]
        );
        if (rowCount !== 1) throw new Error('Strategy missing: cannot block underlying');
      }
      const blocked = !!block;
      const { rows: [remaining] } = await tx.query(
        "SELECT COUNT(*)::int AS n FROM options_live_orders WHERE batch_id=$1 AND status<>'final'",
        [locked.batch_id]
      );
      const batchId = Number(locked.batch_id);
      if (Number(remaining.n) !== 0) return { batchId, completed: false, blocked };
      await tx.query("UPDATE options_live_batches SET status='completed' WHERE id=$1", [locked.batch_id]);
      const { rows: [batch] } = await tx.query(
        'SELECT strategy_id,action_key,action,auto_signal_id FROM options_live_batches WHERE id=$1', [locked.batch_id]
      );
      const autoSignalId = batch?.auto_signal_id == null ? null : Number(batch.auto_signal_id);
      // Entrada enlazada a su señal: se resuelve aquí con los fills reales.
      let signalResolved = false;
      if (autoSignalId != null && batch?.action === 'open' && typeof resolveSignal === 'function') {
        const outcome = await entryOutcomeWith(tx, locked.batch_id);
        const r = outcome && resolveSignal(outcome);
        if (!r || !['opened', 'ignored'].includes(r.decision)) throw new Error('Invalid entry signal resolution');
        await tx.query(
          `UPDATE options_auto_signals
              SET decision = $2, detail = $3, fees_usdt = $4::numeric, fees_estimated = $5::boolean
            WHERE id = $1 AND decision IN ('pending','opened')`,
          [autoSignalId, r.decision, r.detail ?? null, Number(r.feesUsdt) || 0, r.feesEstimated === true]
        );
        signalResolved = true;
      }
      // Sin resolutor (o sin señal enlazada): texto genérico de siempre.
      const match = !signalResolved && /^alert:([0-9]+):(open|close)$/.exec(batch?.action_key || '');
      if (match) {
        const { rows: [fills] } = await tx.query(
          'SELECT COALESCE(SUM(processed_qty),0) AS qty FROM options_live_orders WHERE batch_id=$1',
          [locked.batch_id]
        );
        const executed = Number(fills.qty) > 0;
        await tx.query(
          `UPDATE options_auto_signals SET decision=$3,detail=$4
           WHERE strategy_id=$1 AND alert_event_id=$2 AND decision='pending'`,
          [batch.strategy_id, match[1],
            executed ? (batch.action === 'open' ? 'opened' : 'closed') : 'ignored',
            executed ? 'Ejecución real verificada con Binance (fills conciliados)'
              : 'Sin ejecuciones tras la ventana LIMIT de diez minutos']
        );
      }
      return { batchId, completed: true, action: batch?.action ?? null, autoSignalId, blocked, signalResolved };
    });
  }
  return { assertExchangeExposure, beginBatch, listUnresolved, listByStrategy, countSubmittedSince,
    listMissingTpPositions, beginStandingTp, listQueuedTpOrders, listUnprotectedLivePositions,
    deferExitIfProtected, requestDeadlineExit, listReadyExitRequests, listRestingTpOrderIds, hasStandingTp, requestCancel, requestCancelEntries, hasPendingClose, queueReversal,
    queueSignalReevaluation, batchEntryOutcome, listPendingReentries, hasReentryOrder, markReentry,
    claimAttentionNotification, releaseAttentionNotification, listAttentionOrders,
    listMonitorUsers, listUserOrderIds, claimIncidentNotification,
    claimIncidentNotificationToken, releaseIncidentNotification,
    markSending, markActive, markAttention, markRejected, claimReconcile, releaseReconcile,
    applyTrade, finishOrder };
}

module.exports = createOptionsLiveOrdersRepository();
module.exports.createOptionsLiveOrdersRepository = createOptionsLiveOrdersRepository;
module.exports.compareExposure = compareExposure;
