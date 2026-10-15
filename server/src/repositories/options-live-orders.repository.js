/**
 * Registro transaccional de intenciones y fills reales Binance Options.
 * Ningún POST se hace sin intención durable; cada tradeId se aplica una vez.
 */
const dbDefault = require('../db');
const { grossPnl, signedPremium } = require('../services/options/options-utils');

const map = (r) => r && ({
  id: Number(r.id), batchId: Number(r.batch_id), strategyId: Number(r.strategy_id),
  userId: Number(r.user_id), action: r.action, positionId: r.position_id == null ? null : Number(r.position_id),
  symbol: r.symbol, side: r.side, quantity: Number(r.requested_qty),
  limitPrice: Number(r.limit_price), processedQty: Number(r.processed_qty),
  clientOrderId: r.client_order_id, orderId: r.exchange_order_id, status: r.status,
  leaseUntil: Number(r.reconcile_lease_until || 0),
  createdAt: Number(r.created_at), deadlineAt: Number(r.deadline_at),
  error: r.last_error,
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
      if (!p.symbol || !Number.isFinite(qty)) throw new Error('Invalid Binance live position');
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

  async function beginBatch({ strategy, action, legs, key, detail, deadlineAt, exchangePositions }) {
    if (!legs.length || !['open', 'close'].includes(action)) throw new Error('Invalid live batch');
    return db.transaction(async (tx) => {
      // Locks entre réplicas: un solo lote sin conciliar por usuario,
      // incluso cuando pertenece a distintos bots.
      const { rows: [current] } = await tx.query(
        'SELECT id,user_id,mode,underlying FROM options_strategies WHERE id=$1 FOR UPDATE',
        [strategy.id]
      );
      if (!current || Number(current.user_id) !== Number(strategy.userId) || current.mode !== 'live') {
        throw new Error('Live strategy is no longer active or owned by this user');
      }
      await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [strategy.userId]);
      const { rows: pending } = await tx.query(
        "SELECT id FROM options_live_batches WHERE user_id=$1 AND status <> 'completed' LIMIT 1",
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
      const { rows: existing } = await tx.query(
        'SELECT id FROM options_live_batches WHERE strategy_id=$1 AND action_key=$2',
        [strategy.id, key]
      );
      if (existing.length) return null;
      const time = now();
      const { rows: [batch] } = await tx.query(
        `INSERT INTO options_live_batches
           (strategy_id,user_id,action_key,action,detail,created_at,deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [strategy.id, strategy.userId, key, action, detail || null, time, deadlineAt]
      );
      const orders = [];
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (!String(leg.symbol).startsWith(current.underlying + '-')) {
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

  async function listUnresolved() {
    const { rows } = await db.query(
      "SELECT * FROM options_live_orders WHERE status <> 'final' ORDER BY created_at,id"
    );
    return rows.map(map);
  }

  async function listByStrategy(strategyId) {
    const { rows } = await db.query(
      'SELECT * FROM options_live_orders WHERE strategy_id=$1 ORDER BY id DESC', [strategyId]
    );
    return rows.map(map);
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
      "UPDATE options_live_orders SET status='sending',updated_at=$2 WHERE id=$1 AND status='queued' RETURNING *",
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
           (strategy_id,user_id,mode,symbol,side,quantity,entry_price,opened_at,fees_usdt)
           VALUES ($1,$2,'live',$3,$4,$5,$6,$7,$8)`,
          [locked.strategy_id, locked.user_id, locked.symbol, locked.side,
            quantity, trade.price, trade.at, trade.fee]
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
        const held = Number(position.quantity);
        if (quantity > held + 1e-9) throw new Error('Fill larger than open position');
        const allocatedEntryFee = Number(position.fees_usdt) * (quantity / held);
        const fees = allocatedEntryFee + trade.fee;
        const pnl = grossPnl({ side: position.side, entryPrice: position.entry_price,
          exitPrice: trade.price, quantity }) - fees;
        if (Math.abs(held - quantity) < 1e-9) {
          await tx.query(
            `UPDATE options_strategy_positions
             SET exit_price=$2,closed_at=$3,pnl_usdt=$4,fees_usdt=$5 WHERE id=$1`,
            [position.id, trade.price, trade.at, pnl, fees]
          );
        } else {
          await tx.query(
            'UPDATE options_strategy_positions SET quantity=$2,fees_usdt=$3 WHERE id=$1',
            [position.id, held - quantity, Number(position.fees_usdt) - allocatedEntryFee]
          );
          await tx.query(
            `INSERT INTO options_strategy_positions
             (strategy_id,user_id,mode,symbol,side,quantity,entry_price,exit_price,
              opened_at,closed_at,pnl_usdt,fees_usdt)
             VALUES ($1,$2,'live',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [position.strategy_id, position.user_id, position.symbol, position.side, quantity,
              position.entry_price, trade.price, position.opened_at, trade.at, pnl, fees]
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

  async function finishOrder(id, exchangeOrderId, executedQuantity) {
    return db.transaction(async (tx) => {
      const { rows: [locked] } = await tx.query(
        'SELECT * FROM options_live_orders WHERE id=$1 FOR UPDATE', [id]
      );
      if (!locked || locked.status === 'final') return;
      if (Math.abs(Number(locked.processed_qty) - Number(executedQuantity)) > 1e-8) {
        throw new Error('Execution and trade ledger quantities differ');
      }
      await tx.query(
        `UPDATE options_live_orders SET status='final',
         exchange_order_id=COALESCE($2,exchange_order_id),updated_at=$3,reconcile_lease_until=0
         WHERE id=$1`, [id, exchangeOrderId == null ? null : String(exchangeOrderId), now()]
      );
      const { rows: [remaining] } = await tx.query(
        "SELECT COUNT(*)::int AS n FROM options_live_orders WHERE batch_id=$1 AND status<>'final'",
        [locked.batch_id]
      );
      if (Number(remaining.n) === 0) {
        await tx.query("UPDATE options_live_batches SET status='completed' WHERE id=$1", [locked.batch_id]);
        const { rows: [batch] } = await tx.query(
          'SELECT strategy_id,action_key,action FROM options_live_batches WHERE id=$1', [locked.batch_id]
        );
        const match = /^alert:([0-9]+):(open|close)$/.exec(batch?.action_key || '');
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
      }
    });
  }
  return { assertExchangeExposure, beginBatch, listUnresolved, listByStrategy, countSubmittedSince,
    markSending, markActive, markAttention, claimReconcile, releaseReconcile,
    applyTrade, finishOrder };
}

module.exports = createOptionsLiveOrdersRepository();
module.exports.createOptionsLiveOrdersRepository = createOptionsLiveOrdersRepository;
module.exports.compareExposure = compareExposure;
