/**
 * Motor real de ejecución Binance Options.
 * LIMIT GTC durante 10 minutos, sin fills sintéticos.
 * Orden durable -> POST único -> status/trades -> cancelar remanente -> ledger.
 */
const liveRepo = require('../../repositories/options-live-orders.repository');
const credentialsDefault = require('./options-credentials.service');
const loggerDefault = require('../logger.service');

const WINDOW_MS = 10 * 60_000;
const TERMINAL = new Set(['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
const ACTIVE = new Set(['NEW', 'PARTIALLY_FILLED', 'ACCEPTED']);
const clean = (value) => String(value ?? '');

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
  if (raw.quoteAsset && raw.quoteAsset !== 'USDT') throw new Error('Trade fee currency requires conversion');
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
    this.now = deps.now || Date.now;
    // Habilitación explícita: despliegues y migraciones no envían órdenes solos.
    this.enabled = deps.enabled ?? (process.env.OPTIONS_LIVE_TRADING_ENABLED === 'true');
  }

  async submit(strategy, action, ctx) {
    if (!this.enabled) return { status: 'disabled' };
    if (!['open', 'close'].includes(action.type)) throw new Error('Unsupported live action');
    const client = await this.credentials.getClientForUser(strategy.userId);
    const legs = action.legs || [];
    if (!legs.length || legs.length > 20) throw new Error('Invalid order batch');
    if (legs.some((leg) => !leg.symbol || !['BUY', 'SELL'].includes(leg.side) ||
        !(Number(leg.quantity) > 0) || !(Number(leg.price) > 0))) {
      throw new Error('Invalid order leg');
    }
    if (new Set(legs.map((l) => l.symbol + ':' + (l.positionId ?? ''))).size !== legs.length) {
      throw new Error('Duplicate leg');
    }
    const orders = await this.repo.beginBatch({
      strategy, action: action.type, legs, key: actionKey(strategy, action, ctx),
      detail: action.detail, deadlineAt: this.now() + WINDOW_MS,
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
      // No hubo transición a sending, por tanto NO pudo llamarse a Binance.
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
    const orderId = clean(state.orderId);
    await this.repo.markActive(order.id, orderId);

    let status = clean(state.status).toUpperCase();
    if (!TERMINAL.has(status) && !ACTIVE.has(status)) {
      throw new Error(`Unrecognized Binance order status: ${status}`);
    }
    if (this.now() >= order.deadlineAt && !TERMINAL.has(status)) {
      // Solo cancelar la orden identificada, nunca órdenes ajenas.
      await client.cancelOrder({ symbol: order.symbol, orderId });
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
      if (lastId == null || !/^\\d+$/.test(clean(lastId))) {
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
        await this.repo.releaseReconcile(order.id);
      }
    }
    return { checked: orders.length, reconciled, errors };
  }
}

module.exports = new OptionsLiveExecution();
module.exports.OptionsLiveExecution = OptionsLiveExecution;
module.exports.normalizeTrade = normalizeTrade;
module.exports.actionKey = actionKey;
module.exports.WINDOW_MS = WINDOW_MS;
