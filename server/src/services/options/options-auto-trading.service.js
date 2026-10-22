/**
 * Trading automatizado por alertas: bots de opciones (template `alert_signal`)
 * que abren y cierran cuando se dispara una alerta alcista o bajista.
 *
 * - Se suscribe al emisor de disparos de alertas (`alert-events.js`, se carga
 *   con `require` perezoso en `start()` o se inyecta).
 * - Por cada disparo corre `runner.runForSignal` en los bots del usuario que
 *   escuchan esa alerta y operan el subyacente del activo, y registra la
 *   decisión en `options_auto_signals` (un disparo nunca se procesa dos veces).
 * - Además expone la gestión de bots para `/options/auto-bots`.
 *
 * Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md
 */

const logger = require('../logger.service');
const { AppError, ValidationError, NotFoundError } = require('../../errors/app-error');
const defaultRepo = require('../../repositories/options-strategies.repository');
const { UNDERLYINGS } = require('./options-iv-recorder.service');

const TEMPLATE_ID = 'alert_signal';
const DIRECTIONS = ['bullish', 'bearish', 'neutral'];
const SIGNAL_FILTERS = ['all', 'traded', 'ignored'];
const SIMULATE_COOLDOWN_MS = 10_000;
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD'];

/**
 * 'BTCUSDT' → 'BTC'. Quita el sufijo de cotización y mayusculiza; tolera un
 * prefijo de exchange ('BINANCE:') y separadores ('BTC/USDT'). Devuelve null
 * si el subyacente no está entre los de Binance Opciones.
 */
function assetToUnderlying(asset) {
  let s = String(asset || '').toUpperCase().trim();
  if (s.includes(':')) s = s.slice(s.lastIndexOf(':') + 1);
  s = s.replace(/[/_-]/g, '');
  for (const suffix of QUOTE_SUFFIXES) {
    if (s.length > suffix.length && s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return UNDERLYINGS.includes(s) ? s : null;
}

function alertDirection(alert) {
  return DIRECTIONS.includes(alert?.direction) ? alert.direction : 'neutral';
}

function alertMatchesUnderlying(alert, underlying) {
  return (alert.assetList || []).some((a) => assetToUnderlying(a) === underlying);
}

function signalDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    alertId: row.alertId,
    alertName: row.alertName,
    direction: row.direction,
    asset: row.asset,
    score: row.score,
    decision: row.decision,
    detail: row.detail,
    simulated: row.simulated === true,
    createdAt: row.createdAt,
  };
}

/**
 * Traduce lo que produjo el runner en una decisión. Manda el libro real si
 * el bot está en `live`; si no, la sombra.
 */
function decide(strategy, produced = [], { forceShadow = false } = {}) {
  const mode = strategy.mode === 'live' && !forceShadow ? 'live' : 'shadow';
  const mine = produced.filter((p) => p.mode === mode);
  const booked = mine.filter((p) => p.booked);
  const opened = booked.filter((p) => p.type === 'open');
  const closed = booked.filter((p) => p.type === 'close');
  const notes = mine.filter((p) => !p.booked && p.type !== 'hold');
  const details = [...booked, ...notes].map((p) => p.detail).filter(Boolean);
  const detail = details.join(' · ') || null;
  const prefix = mode === 'live' ? 'Real' : 'Sombra';

  if (opened.length && closed.length) return { decision: 'reversed', detail: `${prefix}: ${detail}` };
  if (opened.length) return { decision: 'opened', detail: `${prefix}: ${detail}` };
  if (closed.length) return { decision: 'closed', detail: `${prefix}: ${detail}` };
  const pending = mine.find((p) => p.pending);
  if (pending) return { decision: 'pending', detail: `${prefix}: ${detail || 'Orden LIMIT enviada, esperando ejecución'}` };
  const error = mine.find((p) => p.type === 'error');
  if (error) return { decision: 'error', detail: `${prefix}: ${error.detail}` };
  return { decision: 'ignored', detail: detail ? `${prefix}: ${detail}` : 'Sin acción' };
}

function lazyAlerts() {
  // eslint-disable-next-line global-require
  return { listAlerts: (...args) => require('../alerts/alerts.service').listAlerts(...args) };
}

function lazyStrategies() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-strategies.service');
  return {
    list: (...args) => load().list(...args),
    create: (...args) => load().create(...args),
    update: (...args) => load().update(...args),
  };
}

function lazyRunner() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-strategy-runner.service');
  return {
    runForSignal: (...args) => load().runForSignal(...args),
    closeManually: (...args) => load().closeManually(...args),
  };
}

function lazyLiveOrders() {
  // eslint-disable-next-line global-require
  const load = () => require('../../repositories/options-live-orders.repository');
  return {
    listByStrategy: (...args) => load().listByStrategy(...args),
    hasPendingClose: (...args) => load().hasPendingClose(...args),
    requestCancel: (...args) => load().requestCancel(...args),
  };
}

const CLOSE_FALLBACK = {
  closed: 'Posiciones cerradas',
  pending: 'Orden LIMIT de cierre enviada, esperando ejecución',
  nothing_to_close: 'No hay posiciones abiertas que cerrar',
  not_submitted: 'No se envió la orden de cierre',
};

function orderDto(o) {
  return {
    id: o.id, purpose: o.purpose, action: o.action, symbol: o.symbol, side: o.side,
    price: o.limitPrice, quantity: o.quantity, executedQty: o.processedQty,
    status: o.status, cancelRequested: o.cancelRequested,
  };
}

function createOptionsAutoTradingService(deps = {}) {
  const repo = deps.repo || defaultRepo;
  const runner = deps.runner || lazyRunner();
  const alerts = deps.alerts || lazyAlerts();
  const strategies = deps.strategies || lazyStrategies();
  const liveOrders = deps.liveOrders || lazyLiveOrders();
  const log = deps.logger || logger;
  const now = deps.now || Date.now;
  let unsubscribe = null;
  const lastSimulation = new Map(); // botId → instante de la última simulación

  // ---------- señales ----------

  async function processBot(bot, payload, underlying) {
    const direction = DIRECTIONS.includes(payload.direction) ? payload.direction : 'neutral';
    const claim = await repo.claimAutoSignal({
      strategyId: bot.id,
      userId: bot.userId,
      alertId: payload.alertId,
      alertEventId: payload.eventId ?? null,
      alertName: payload.alertName ?? null,
      direction,
      asset: payload.asset ?? null,
      score: payload.score ?? null,
      decision: direction === 'neutral' ? 'ignored' : 'pending',
      detail: direction === 'neutral' ? 'Alerta neutral' : 'Procesando…',
      createdAt: now(),
    });
    if (!claim) return { strategyId: bot.id, decision: 'duplicate' };
    if (direction === 'neutral') return { strategyId: bot.id, decision: 'ignored', detail: 'Alerta neutral' };

    let outcome;
    try {
      const { produced } = await runner.runForSignal(bot, {
        direction,
        alertId: payload.alertId,
        alertName: payload.alertName ?? null,
        asset: payload.asset ?? null,
        underlying,
        score: payload.score ?? null,
        eventId: payload.eventId ?? null,
        triggeredAt: payload.triggeredAt ?? null,
        optionExpiryMinDays: payload.optionExpiryMinDays ?? null,
        optionExpiryMaxDays: payload.optionExpiryMaxDays ?? null,
      });
      outcome = decide(bot, produced);
    } catch (err) {
      log.warn('options_auto_signal_failed', { strategyId: bot.id, alertId: payload.alertId, error: err.message });
      outcome = { decision: 'error', detail: `Error al procesar la señal: ${err.message}` };
    }
    await repo.finishAutoSignal(claim.id, outcome);
    return { strategyId: bot.id, ...outcome };
  }

  /** Procesa un disparo de alerta. Devuelve la decisión por bot (para pruebas y logs). */
  async function handleAlertTriggered(payload = {}) {
    const userId = Number(payload.userId);
    const alertId = Number(payload.alertId);
    if (!Number.isFinite(userId) || !Number.isFinite(alertId)) return [];
    const underlying = assetToUnderlying(payload.asset);
    if (!underlying) return [];

    const bots = (await repo.listActiveAlertBots(userId)).filter((b) => (
      b.underlying === underlying
      && Array.isArray(b.params?.alertIds)
      && b.params.alertIds.map(Number).includes(alertId)
    ));
    const results = [];
    for (const bot of bots) {
      try {
        results.push(await processBot(bot, payload, underlying));
      } catch (err) {
        log.warn('options_auto_signal_record_failed', { strategyId: bot.id, error: err.message });
        results.push({ strategyId: bot.id, decision: 'error', detail: err.message });
      }
    }
    return results;
  }

  function start() {
    if (unsubscribe) return true;
    let events = deps.alertEvents;
    if (!events) {
      try {
        // eslint-disable-next-line global-require
        events = require('../alerts/alert-events');
      } catch (err) {
        log.warn('options_auto_trading_no_emitter', { error: err.message });
        return false;
      }
    }
    unsubscribe = events.onAlertTriggered((payload) => handleAlertTriggered(payload));
    log.info('options_auto_trading_started');
    return true;
  }

  function stop() {
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
  }

  // ---------- gestión de bots ----------

  async function userAlerts(userId) {
    return (await alerts.listAlerts(userId)) || [];
  }

  async function requireBot(userId, id) {
    const bot = await repo.getStrategy(userId, id);
    if (!bot || bot.template !== TEMPLATE_ID) throw new NotFoundError('Bot no encontrado');
    return bot;
  }

  function normalizeUnderlying(value) {
    const underlying = String(value || '').toUpperCase();
    if (!UNDERLYINGS.includes(underlying)) {
      throw new ValidationError(`Subyacente no soportado: ${value}. Opciones: ${UNDERLYINGS.join(', ')}`);
    }
    return underlying;
  }

  /** Las alertas deben ser del usuario, no neutrales y del mismo subyacente. */
  async function validateAlertIds(userId, alertIds, underlying) {
    if (!Array.isArray(alertIds) || !alertIds.length) throw new ValidationError('Elige al menos una alerta');
    const ids = [...new Set(alertIds.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new ValidationError('Ids de alerta inválidos');
    const byId = new Map((await userAlerts(userId)).map((a) => [Number(a.id), a]));
    for (const id of ids) {
      const alert = byId.get(id);
      if (!alert) throw new ValidationError(`La alerta ${id} no existe`);
      if (alertDirection(alert) === 'neutral') {
        throw new ValidationError(`La alerta «${alert.name}» es neutral: dale dirección alcista o bajista para usarla en un bot`);
      }
      if (!alertMatchesUnderlying(alert, underlying)) {
        throw new ValidationError(`La alerta «${alert.name}» no vigila ${underlying}`);
      }
    }
    return ids;
  }

  async function listBots(userId) {
    const [bots, alertList, lastSignals] = await Promise.all([
      strategies.list(userId, { alertBots: true }),
      userAlerts(userId),
      repo.lastAutoSignalsByUser(userId),
    ]);
    const byId = new Map(alertList.map((a) => [Number(a.id), a]));
    return bots.map((bot) => ({
      ...bot,
      alerts: (bot.params?.alertIds || [])
        .map((id) => byId.get(Number(id)))
        .filter(Boolean)
        .map((a) => ({ id: Number(a.id), name: a.name, direction: alertDirection(a), assetList: a.assetList || [],
          optionExpiryMinDays: a.optionExpiryMinDays ?? null, optionExpiryMaxDays: a.optionExpiryMaxDays ?? null })),
      lastSignal: signalDto(lastSignals.find((s) => s.strategyId === bot.id)),
    }));
  }

  async function botSummary(userId, id) {
    return (await listBots(userId)).find((b) => b.id === id) || null;
  }

  async function eligibleAlerts(userId, underlyingRaw) {
    const underlying = normalizeUnderlying(underlyingRaw);
    return (await userAlerts(userId))
      .filter((a) => alertDirection(a) !== 'neutral' && alertMatchesUnderlying(a, underlying))
      .map((a) => ({
        id: Number(a.id),
        name: a.name,
        direction: alertDirection(a),
        assetList: a.assetList || [],
        thresholdPercent: a.thresholdPercent ?? null,
      }));
  }

  async function createBot(userId, body = {}) {
    const underlying = normalizeUnderlying(body.underlying);
    const alertIds = await validateAlertIds(userId, body.alertIds, underlying);
    const created = await strategies.create(userId, {
      name: body.name,
      template: TEMPLATE_ID,
      underlying,
      params: { ...(body.params || {}), alertIds },
      limits: body.limits,
      mode: 'shadow',
    }, { alertBots: true });
    return (await botSummary(userId, created.id)) || created;
  }

  /** Copia un bot en sombra (nunca hereda Real) con los mismos params/límites. */
  async function cloneBot(userId, id) {
    const bot = await requireBot(userId, id);
    const suffix = ' (copia)';
    const created = await strategies.create(userId, {
      name: `${String(bot.name || '').slice(0, 120 - suffix.length)}${suffix}`,
      template: TEMPLATE_ID,
      underlying: bot.underlying,
      params: JSON.parse(JSON.stringify(bot.params || {})),
      limits: JSON.parse(JSON.stringify(bot.limits || {})),
      mode: 'shadow',
    }, { alertBots: true });
    return (await botSummary(userId, created.id)) || created;
  }

  async function updateBot(userId, id, body = {}) {
    const bot = await requireBot(userId, id);
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.limits !== undefined) patch.limits = body.limits;
    const params = body.params !== undefined ? { ...(body.params || {}) } : null;
    const rawIds = body.alertIds !== undefined ? body.alertIds : params?.alertIds;
    if (rawIds !== undefined) {
      const alertIds = await validateAlertIds(userId, rawIds, bot.underlying);
      patch.params = { ...(params || {}), alertIds };
    } else if (params) {
      patch.params = params;
    }
    const updated = await strategies.update(userId, id, patch, { alertBots: true });
    return (await botSummary(userId, id)) || updated;
  }

  async function listSignals(userId, id, { limit = 100, filter = 'all' } = {}) {
    await requireBot(userId, id);
    if (!SIGNAL_FILTERS.includes(filter)) throw new ValidationError(`Filtro inválido: ${filter}. Opciones: ${SIGNAL_FILTERS.join(', ')}`);
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new ValidationError('limit debe ser un entero entre 1 y 500');
    return (await repo.listAutoSignals(id, { limit: n, filter })).map(signalDto);
  }

  // ---------- cierre manual y cancelación ----------

  /**
   * Cierra a mano las posiciones del libro del modo actual (Real → live,
   * si no → shadow). Devuelve `{ status, detail }`, con `detail` legible
   * (p. ej. por qué no se envió: sin liquidez, envío real deshabilitado…).
   */
  async function closeBot(userId, id, { positionIds, confirm } = {}) {
    if (confirm !== true) {
      throw new AppError('Cerrar posiciones requiere confirmación: envía confirm: true', { status: 400, code: 'CONFIRM_REQUIRED' });
    }
    const bot = await requireBot(userId, id);
    const mode = bot.mode === 'live' ? 'live' : 'shadow';
    const ids = Array.isArray(positionIds) ? positionIds.map(Number) : undefined;
    if (mode === 'live' && await liveOrders.hasPendingClose({ userId, strategyId: bot.id, positionIds: ids })) {
      throw new AppError('Ya hay un cierre en curso para esta posición', { status: 409, code: 'CLOSE_PENDING' });
    }
    const { status, produced = [] } = await runner.closeManually(bot, { mode, positionIds: ids });
    const detail = produced
      .filter((p) => p.mode === mode)
      .map((p) => p.detail)
      .filter(Boolean)
      .join(' · ') || CLOSE_FALLBACK[status] || status;
    // Un cierre en sombra ya deja su evento «Cierre manual» con las patas.
    if (status === 'pending' || status === 'not_submitted') {
      try {
        await repo.insertEvent({
          strategyId: bot.id,
          userId: bot.userId,
          mode,
          action: status === 'pending' ? 'close' : 'skip',
          detail: status === 'pending' ? `Cierre manual: ${detail}` : `Cierre manual no enviado: ${detail}`,
          createdAt: now(),
        });
      } catch (err) {
        log.warn('options_manual_close_event_failed', { strategyId: bot.id, error: err.message });
      }
    }
    log.info('options_manual_close', { strategyId: bot.id, mode, status, positions: ids?.length ?? 'all' });
    return { status, detail };
  }

  /** Pide cancelar una entrada real pendiente del bot (ni TP ni salidas). */
  async function cancelOrder(userId, id, orderId) {
    const bot = await requireBot(userId, id);
    const order = (await liveOrders.listByStrategy(bot.id))
      .find((o) => Number(o.id) === Number(orderId) && Number(o.userId) === Number(userId));
    if (!order) throw new NotFoundError('Orden no encontrada');
    if (order.purpose === 'take_profit') {
      throw new AppError('El TP residente se cancela cerrando la posición', { status: 409, code: 'ORDER_NOT_CANCELLABLE' });
    }
    if (order.action !== 'open') {
      throw new AppError('Las salidas no se pueden cancelar: se reintentan solas hasta ejecutarse', { status: 409, code: 'EXIT_NOT_CANCELLABLE' });
    }
    if (order.status === 'final') {
      throw new AppError('La orden ya terminó y no se puede cancelar', { status: 409, code: 'ORDER_FINAL' });
    }
    const updated = await liveOrders.requestCancel({ userId, strategyId: bot.id, orderId: order.id });
    if (!updated) throw new AppError('La orden ya no se puede cancelar', { status: 409, code: 'ORDER_FINAL' });
    log.info('options_order_cancel_requested', { strategyId: bot.id, orderId: order.id });
    return orderDto(updated);
  }

  /**
   * Simula una señal en el libro sombra (aunque el bot esté en Real): no hay
   * evento de alerta, así que no hay dedupe; se limita a 1 cada 10 s por bot.
   */
  async function simulateSignal(userId, id, { direction } = {}) {
    if (!['bullish', 'bearish'].includes(direction)) {
      throw new ValidationError('direction debe ser bullish o bearish');
    }
    const bot = await requireBot(userId, id);
    if (bot.mode !== 'shadow' && bot.mode !== 'live') {
      throw new AppError('Pasa el bot a Sombra para simular', { status: 409, code: 'BOT_PAUSED' });
    }
    const at = now();
    const last = lastSimulation.get(bot.id);
    if (last !== undefined && at - last < SIMULATE_COOLDOWN_MS) {
      throw new AppError('Espera unos segundos antes de simular otra señal', { status: 429, code: 'SIMULATE_RATE_LIMIT' });
    }
    lastSimulation.set(bot.id, at);

    const claim = await repo.claimAutoSignal({
      strategyId: bot.id,
      userId: bot.userId,
      alertId: null,
      alertEventId: null,
      alertName: 'Simulación',
      direction,
      asset: bot.underlying,
      score: null,
      decision: 'pending',
      detail: 'Procesando…',
      simulated: true,
      createdAt: at,
    });
    let outcome;
    try {
      const { produced } = await runner.runForSignal(bot, {
        direction,
        alertId: null,
        alertName: 'Simulación',
        asset: bot.underlying,
        underlying: bot.underlying,
        score: null,
        eventId: null,
        triggeredAt: at,
        simulated: true,
      }, { shadowOnly: true });
      outcome = decide(bot, produced, { forceShadow: true });
    } catch (err) {
      log.warn('options_auto_signal_simulation_failed', { strategyId: bot.id, error: err.message });
      outcome = { decision: 'error', detail: `Error al simular la señal: ${err.message}` };
    }
    await repo.finishAutoSignal(claim.id, outcome);
    return outcome;
  }

  return {
    start,
    stop,
    simulateSignal,
    handleAlertTriggered,
    listBots,
    eligibleAlerts,
    createBot,
    cloneBot,
    updateBot,
    listSignals,
    closeBot,
    cancelOrder,
  };
}

module.exports = createOptionsAutoTradingService();
module.exports.createOptionsAutoTradingService = createOptionsAutoTradingService;
module.exports.assetToUnderlying = assetToUnderlying;
module.exports.decide = decide;
