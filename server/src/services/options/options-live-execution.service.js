/**
 * Motor real de ejecución Binance Options.
 * LIMIT GTC durante 10 minutos, sin fills sintéticos.
 * Orden durable -> POST único -> status/trades -> cancelar remanente -> ledger.
 */
const liveRepo = require('../../repositories/options-live-orders.repository');
const credentialsDefault = require('./options-credentials.service');
const loggerDefault = require('../logger.service');
const { validateBinanceOrderBatch } = require('./options-order-filters');
const { parseSymbol } = require('./options-utils');
const { projectTakeProfit } = require('./options-take-profit');
const alertSignal = require('./templates/alert-signal');

const WINDOW_MS = 10 * 60_000;
const TERMINAL = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED']);
const ACTIVE = new Set(['NEW', 'PARTIALLY_FILLED', 'ACCEPTED']);
const clean = (value) => String(value ?? '');

function standingPrice({ position, params, tickSize, minPrice, quote, atrHourly, now }) {
  const side = position.side;
  const origin = Number(minPrice);
  const tick = Number(tickSize);
  if (!Number.isFinite(origin) || origin < 0 || !(tick > 0)) return null;
  if (params.takeProfitMode === 'volatility') {
    const meta = parseSymbol(position.symbol);
    if (!meta || !quote) return null;
    return projectTakeProfit({
      entryPrice: position.entryPrice, spot: Number(quote.spot),
      strike: meta.strike, type: meta.type, side,
      iv: Number(quote.iv), expiryMs: meta.expiryMs, nowMs: now,
      atrHourly, tickSize: tick, minPrice: origin,
      atrMultiplier: params.tpAtrMultiplier, horizonHours: params.tpHorizonHours,
    })?.price ?? null;
  }
  // Fijo: precios resting que permiten salir con la prima objetivo, nunca
  // confiar en un mark o una cotización ejecutable que ya se movió.
  const pct = Number(params.takeProfitPct) / 100;
  const raw = side === 'BUY'
    ? position.entryPrice * (1 + pct)
    : position.entryPrice * (1 - pct);
  const scaled = (raw - origin) / tick;
  const steps = side === 'BUY' ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9);
  const price = Number((origin + steps * tick).toFixed(10));
  if (!(price > 0) ||
      (side === 'BUY' && price <= position.entryPrice) ||
      (side === 'SELL' && price >= position.entryPrice)) return null;
  return price;
}

function normalizeTrade(raw, order, exchangeOrderId) {
  if (clean(raw.orderId) !== clean(exchangeOrderId)) return null;
  if (raw.symbol !== order.symbol || raw.side !== order.side) {
    throw new Error('Binance trade symbol/side mismatch');
  }
  const id = raw.tradeId ?? raw.id;
  const quantity = Number(raw.quantity);
  const price = Number(raw.price);
  const fee = Number(raw.fee);
  const at = Number(raw.time);
  if (id == null || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(price) || price <= 0 ||
      raw.fee == null || !Number.isFinite(fee) ||
      !Number.isFinite(at)) {
    throw new Error('Binance trade incomplete: cannot book without quantity, price, fee and id');
  }
  if (raw.quoteAsset !== 'USDT') throw new Error('Trade fee currency is not confirmed as USDT');
  return { id: clean(id), quantity, price, fee: Math.abs(fee), at };
}

function actionKey(strategy, action, ctx) {
  const eventId = ctx.signal?.eventId;
  if (strategy.template === 'alert_signal' && ctx.signal && eventId == null) {
    throw new Error('Live signal requires a durable alert eventId');
  }
  if (eventId != null) return `alert:${eventId}:${action.type}`;
  if (action.type === 'open') {
    // Nunca repetir una entrada calendarizada si expiró sin fills.
    const day = new Date(ctx.now).toISOString().slice(0, 10);
    return `scheduled:${day}:${action.legs.map((l) => l.symbol).sort().join(',')}`;
  }
  // Cierres por stop/toma de ganancia pueden reintentarse en otro tick.
  return `close:${Math.floor(ctx.now / 60_000)}:${action.legs.map((l) => l.positionId).sort().join(',')}`;
}

class OptionsLiveExecution {
  constructor(deps = {}) {
    this.repo = deps.repo || liveRepo;
    this.credentials = deps.credentials || credentialsDefault;
    this.logger = deps.logger || loggerDefault;
    this.market = deps.market || require('./options-market.service');
    this.now = deps.now || Date.now;
    this.lastExternalScanAt = null;
    this.settlement = deps.settlement || require('./options-live-settlement.service');
    this.notify = deps.notify || (async (userId, message) => {
      const registry = require('../telegram.registry');
      const tg = await registry.getOrCreate(userId);
      if (typeof tg?.send !== 'function') throw new Error('Telegram unavailable');
      await tg.send(message);
    });
    // Doble autorización independiente; no se activa al aplicar migraciones.
    // La segunda solo se configura tras la validación final de producción.
    this.enabled = deps.enabled ?? (
      process.env.OPTIONS_LIVE_TRADING_ENABLED === 'true' &&
      process.env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'true'
    );
  }

  async submit(strategy, action, ctx) {
    if (!this.enabled) return { status: 'disabled' };
    if (!['open', 'close'].includes(action.type)) throw new Error('Unsupported live action');
    const client = await this.credentials.getClientForUser(strategy.userId);
    if (typeof client.getPositions !== 'function' ||
        typeof client.getOpenOrders !== 'function' ||
        typeof this.repo.assertExchangeExposure !== 'function') {
      throw new Error('Binance exposure and open-order checks are unavailable');
    }
    if (action.type === 'close' &&
        typeof this.repo.deferExitIfProtected === 'function' &&
        await this.repo.deferExitIfProtected(strategy, action)) {
      return { status: 'tp_cancel_requested', sent: 0 };
    }
    // Una orden manual que todavía no ha llenado no aparece en posiciones:
    // puede ejecutarse después de nuestro preflight. Bloquear hasta que
    // la cuenta no tenga órdenes abiertas no gestionadas por este lote.
    const openOrders = await client.getOpenOrders();
    if (!Array.isArray(openOrders)) throw new Error('Invalid Binance open-order list');
    if (openOrders.length) {
      if (action.type !== 'close' ||
          typeof this.repo.listRestingTpOrderIds !== 'function') {
        throw new Error('Binance account has pending orders: manual reconciliation required');
      }
      const mine = await this.repo.listRestingTpOrderIds(strategy.userId);
      const ids = new Set(mine.map((o) => clean(o.clientOrderId)));
      const orderIds = new Set(mine.map((o) => clean(o.orderId)).filter(Boolean));
      // Cerrar otra posición es admisible si las únicas órdenes resting
      // ajenas al objetivo son TPs propios e identificados.
      if (openOrders.some((o) =>
        !ids.has(clean(o.clientOrderId)) && !orderIds.has(clean(o.orderId)))) {
        throw new Error('Binance account has pending orders: manual reconciliation required');
      }
    }
    // No enviar órdenes si existen posiciones ajenas o fills que todavía
    // no figuran en el ledger local.
    const exchangePositions = await client.getPositions();
    await this.repo.assertExchangeExposure(strategy.userId, exchangePositions);
    const legs = action.legs || [];
    if (!legs.length || legs.length > 20) throw new Error('Invalid order batch');
    if (legs.some((leg) => !leg.symbol || !['BUY', 'SELL'].includes(leg.side) ||
        !(Number(leg.quantity) > 0) || !(Number(leg.price) > 0))) {
      throw new Error('Invalid order leg');
    }
    if (new Set(legs.map((l) => l.symbol + ':' + (l.positionId ?? ''))).size !== legs.length) {
      throw new Error('Duplicate leg');
    }
    // Binance Options usa filtros con mínimo como origen del paso:
    // (precio-minPrice) % tickSize y (qty-minQty) % stepSize.
    // Bloquear ANTES del batch: nunca confiar en redondeos UI/market.
    const deadlineAt = this.now() + WINDOW_MS;
    const exchangeInfo = await client.getExchangeInfo();
    validateBinanceOrderBatch(exchangeInfo, legs, this.now(), deadlineAt);
    const orders = await this.repo.beginBatch({
      strategy, action: action.type, legs, key: actionKey(strategy, action, ctx),
      detail: action.detail, deadlineAt,
      exchangePositions,
    });
    if (!orders) return { status: 'duplicate_or_unresolved' };
    let sent = 0;
    for (const order of orders) {
      // No enviar patas restantes si la ventana expiró mientras se procesaban
      // otras órdenes. Quedan 'queued' y el reconciliador las finaliza a cero.
      if (this.now() >= order.deadlineAt) {
        return { status: 'deadline', sent };
      }
      // Si el proceso cae después de este cambio, no se reenvía: se consulta
      // por clientOrderId antes de decidir si la orden existe.
      const claimed = await this.repo.markSending(order.id);
      if (!claimed) throw new Error('Order submission was already claimed');
      try {
        const response = await client.placeOrder({
          symbol: order.symbol, side: order.side, quantity: order.quantity,
          price: order.limitPrice, reduceOnly: action.type === 'close',
          clientOrderId: order.clientOrderId,
        });
        // Resultado = acuse de recepción; NO se registra posición aquí.
        if (response?.orderId == null ||
            (response.symbol && response.symbol !== order.symbol) ||
            (response.side && response.side !== order.side) ||
            (response.clientOrderId && response.clientOrderId !== order.clientOrderId)) {
          throw new Error('Binance acknowledgement identity mismatch');
        }
        await this.repo.markActive(order.id, response.orderId);
        sent += 1;
      } catch (err) {
        await this.repo.markAttention(order.id, `Envio ambiguo: ${err.message}`);
        this.logger.warn('options_live_submission_uncertain', {
          strategyId: strategy.id, liveOrderId: order.id, error: err.message,
        });
        // Detener el envío de las demás patas; las ya enviadas se concilian.
        return { status: 'attention', sent, error: err.message };
      }
    }
    return { status: 'submitted', sent };
  }

  async reconcileOrder(order, client) {
    if (order.status === 'queued') {
      // Mientras la ventana siga abierta, el sender todavía puede reclamar
      // esta pata. Nunca marcarla final antes de su deadline.
      if (this.now() < order.deadlineAt && !order.cancelRequested) return;
      // Solo finishOrder puede finalizarla, y únicamente si la fila
      // continúa en 'queued' bajo FOR UPDATE.
      await this.repo.finishOrder(order.id, null, 0);
      return;
    }
    const args = { symbol: order.symbol, ...(order.orderId
      ? { orderId: order.orderId } : { clientOrderId: order.clientOrderId }) };
    let state = await client.getOrder(args);
    if (!state || state.orderId == null || state.symbol !== order.symbol || state.side !== order.side ||
        (order.orderId != null && clean(state.orderId) !== clean(order.orderId))) {
      throw new Error('Binance order identity mismatch');
    }
    if (state.clientOrderId && state.clientOrderId !== order.clientOrderId) {
      throw new Error('Binance clientOrderId mismatch');
    }
    if (state.quantity == null || !Number.isFinite(Number(state.quantity)) ||
        Math.abs(Number(state.quantity) - order.quantity) > 1e-8 ||
        (state.type != null && state.type !== 'LIMIT') ||
        (state.timeInForce != null && state.timeInForce !== 'GTC')) {
      throw new Error('Binance order terms disagree with local ledger');
    }
    const orderId = clean(state.orderId);
    await this.repo.markActive(order.id, orderId);

    let status = clean(state.status).toUpperCase();
    if (!TERMINAL.has(status) && !ACTIVE.has(status)) {
      throw new Error(`Unrecognized Binance order status: ${status}`);
    }
    if ((this.now() >= order.deadlineAt || order.cancelRequested) && !TERMINAL.has(status)) {
      // Nunca enviar otro cierre antes de confirmar la cancelación del TP.
      try {
        await client.cancelOrder({ symbol: order.symbol, orderId });
      } catch (err) {
        const rechecked = await client.getOrder({ symbol: order.symbol, orderId });
        if (!TERMINAL.has(clean(rechecked?.status).toUpperCase())) throw err;
      }
      state = await client.getOrder({ symbol: order.symbol, orderId });
      status = clean(state?.status).toUpperCase();
      if (!TERMINAL.has(status) && !ACTIVE.has(status)) {
        throw new Error('Unable to verify cancellation status');
      }
    }

    // Paginación por id de trade (entero potencialmente > MAX_SAFE_INTEGER).
    // Nunca asumir que los primeros 1000 son toda la historia.
    const rawTrades = [];
    let fromId;
    for (let page = 0; page < 20; page++) {
      const chunk = await client.getUserTrades({
        symbol: order.symbol,
        startTime: Math.max(0, order.createdAt - 60_000),
        endTime: this.now(), limit: 1000,
        ...(fromId == null ? {} : { fromId }),
      });
      if (!Array.isArray(chunk) || chunk.length > 1000) {
        throw new Error('Invalid Binance trade page');
      }
      rawTrades.push(...chunk);
      if (chunk.length < 1000) break;
      const lastId = chunk[chunk.length - 1]?.id;
      if (lastId == null || !/^\d+$/.test(clean(lastId))) {
        throw new Error('Trade pagination requires precise numeric id');
      }
      const next = (BigInt(clean(lastId)) + 1n).toString();
      if (fromId != null && BigInt(next) <= BigInt(fromId)) {
        throw new Error('Binance trade pagination did not advance');
      }
      fromId = next;
      if (page === 19) throw new Error('Trade history exceeds reconciliation page budget');
    }
    const trades = rawTrades.map((t) => normalizeTrade(t, order, orderId))
      .filter(Boolean).sort((a, b) => a.at - b.at);
    // Comprobar antes de contabilizar: no superar la cantidad ordenada.
    const sum = trades.reduce((total, t) => total + t.quantity, 0);
    const executed = Number(state.executedQty);
    const alreadyProcessed = Number(order.processedQty || 0);
    if (!Number.isFinite(executed) || executed < 0 || executed > order.quantity + 1e-8 ||
        sum > executed + 1e-8 || executed + 1e-8 < alreadyProcessed) {
      throw new Error('Trade quantities disagree with Binance order');
    }
    for (const trade of trades) await this.repo.applyTrade({ ...order, orderId }, trade);
    if (TERMINAL.has(status) && Math.abs(sum - executed) < 1e-8) {
      await this.repo.finishOrder(order.id, orderId, executed);
    }
  }

  async reconcileExpired() {
    // No requiere flag de trading: la auditoría de operaciones anteriores
    // debe continuar incluso cuando se bloquean nuevas entradas.
    return this.settlement.reconcileExpired();
  }

  async scanExternalAccounts() {
    // Auditoría periódica de todas las cuentas con bots live o órdenes
    // pendientes, incluso si no hay ninguna orden enviada esta semana.
    if (typeof this.repo.listMonitorUsers !== 'function' ||
        typeof this.repo.listUserOrderIds !== 'function' ||
        typeof this.repo.claimIncidentNotification !== 'function') return { checked: 0 };
    const users = await this.repo.listMonitorUsers(50);
    let incidents = 0;
    for (const userId of users) {
      try {
        const client = await this.credentials.getClientForUser(userId);
        const [open, positions, known] = await Promise.all([
          client.getOpenOrders(), client.getPositions(), this.repo.listUserOrderIds(userId),
        ]);
        if (!Array.isArray(open) || !Array.isArray(positions)) {
          throw new Error('Binance account returned invalid exposure or order list');
        }
        const tracked = new Map(known.map((o) => [o.clientOrderId, o.status]));
        const orphaned = open.filter((o) =>
          !o.clientOrderId || !tracked.has(o.clientOrderId) || tracked.get(o.clientOrderId) === 'final');
        if (orphaned.length) {
          const claimed = await this.repo.claimIncidentNotification(
            userId, 'ORPHAN_OPEN_ORDERS', 'account'
          );
          if (claimed) {
            await this.notify(userId,
              '<b>ALERTA · Órdenes Binance sin seguimiento</b>\\n' +
              'Existen ' + orphaned.length + ' órdenes abiertas no conciliadas. ' +
              'Bloquear nuevas entradas y revisar manualmente.');
          }
          incidents++;
        }
        try {
          await this.repo.assertExchangeExposure(userId, positions);
        } catch (err) {
          incidents++;
          if (await this.repo.claimIncidentNotification(userId, 'EXPOSURE_MISMATCH', 'account')) {
            await this.notify(userId,
              '<b>ALERTA · Exposición Binance distinta del libro</b>\\n' +
              'No abrir nuevas órdenes hasta investigar los fills y posiciones.');
          }
        }
      } catch (err) {
        incidents++;
        this.logger.warn('options_live_account_audit_failed', {
          userId, error: err.message,
        });
        try {
          if (await this.repo.claimIncidentNotification(userId, 'ACCOUNT_AUDIT_UNAVAILABLE', 'account')) {
            await this.notify(userId,
              '<b>ALERTA · Verificación Binance no disponible</b>\\n' +
              'Falló la consulta de posiciones/órdenes o credenciales. Revisar la cuenta.');
          }
        } catch (notifyErr) {
          this.logger.warn('options_live_account_audit_notify_failed', {
            userId, error: notifyErr.message,
          });
        }
      }
    }
    return { checked: users.length, incidents };
  }

  async alertAttention() {
    if (typeof this.repo.listAttentionOrders !== 'function' ||
        typeof this.repo.claimAttentionNotification !== 'function') return 0;
    const ids = await this.repo.listAttentionOrders(100);
    let sent = 0;
    for (const id of ids) {
      const order = await this.repo.claimAttentionNotification(id);
      if (!order) continue;
      const cleanMsg = (value) => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const message = [
        '<b>ALERTA · Binance Opciones sin conciliar</b>',
        'Bot: ' + cleanMsg(order.strategy_id),
        'Orden: ' + cleanMsg(order.client_order_id),
        'Contrato: ' + cleanMsg(order.symbol),
        'Motivo: ' + cleanMsg(String(order.last_error || 'Atención requerida').slice(0, 300)),
        'No enviar nuevas órdenes hasta verificar Binance y el ledger.',
      ].join('\\n');
      try {
        await this.notify(Number(order.user_id), message);
        sent++;
      } catch (err) {
        this.logger.warn('options_live_attention_notify_failed', {
          liveOrderId: Number(order.id), error: err.message,
        });
      }
    }
    return sent;
  }

  async reconcilePending() {
    // Aun con nuevas entradas deshabilitadas, se cancelan y concilian
    // órdenes ya enviadas antes de cambiar el feature flag.
    const orders = await this.repo.listUnresolved();
    let reconciled = 0;
    let errors = 0;
    for (const order of orders) {
      // Lease PostgreSQL evita que varias réplicas concilien la misma orden.
      const locked = await this.repo.claimReconcile(order.id);
      if (!locked) continue;
      try {
        const client = order.status === 'queued'
          ? null : await this.credentials.getClientForUser(order.userId);
        await this.reconcileOrder(locked, client);
        reconciled += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn('options_live_reconciliation_failed', {
          strategyId: order.strategyId, liveOrderId: order.id, error: err.message,
        });
        await this.repo.markAttention(order.id, `Conciliacion: ${err.message}`);
      } finally {
        await this.repo.releaseReconcile(order.id, locked.leaseUntil);
      }
    }
    // Notificación aún con trading apagado, sin interrumpir la conciliación.
    let alerts = 0;
    try {
      alerts = await this.alertAttention();
    } catch (err) {
      this.logger.warn('options_live_attention_scan_failed', { error: err.message });
    }
    // Auditoría de cuenta cada cinco minutos. No depende del flag de envío.
    let accountAudit = null;
    if (this.lastExternalScanAt == null ||
        this.now() - this.lastExternalScanAt >= 5 * 60_000) {
      this.lastExternalScanAt = this.now();
      try {
        accountAudit = await this.scanExternalAccounts();
      } catch (err) {
        this.logger.warn('options_live_account_audit_scan_failed', { error: err.message });
      }
    }
    return { checked: orders.length, reconciled, errors, alerts, accountAudit };
  }
}

module.exports = new OptionsLiveExecution();
module.exports.OptionsLiveExecution = OptionsLiveExecution;
module.exports.normalizeTrade = normalizeTrade;
module.exports.actionKey = actionKey;
module.exports.WINDOW_MS = WINDOW_MS;
