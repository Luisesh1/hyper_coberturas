/**
 * Gestión de estrategias de opciones (CRUD, cambio de modo y vistas con KPIs).
 * El paso a `live` exige confirmación explícita, credenciales de Binance
 * Opciones y no superar `maxLiveStrategies` de los límites globales.
 */

const { AppError, ValidationError, NotFoundError } = require('../../errors/app-error');
const defaultRepo = require('../../repositories/options-strategies.repository');
const templates = require('./templates');
const { UNDERLYINGS } = require('./options-iv-recorder.service');
const { DAY_MS, parseSymbol, tradeFee } = require('./options-utils');
const { estimateMargin, legDeltaExposure, utcDayStart, lazyMarket } = require('./options-strategy-runner.service');
const { committedUsdt: computeCommitted, shadowEntriesAsOrders } = require('./options-committed-capital');

const MODES = ['paused', 'shadow', 'live'];
const LIMIT_KEYS = ['maxMarginUsdt', 'maxDailyLossUsdt', 'maxNetDelta', 'maxOrdersPerDay'];
const DEFAULT_LIMITS = { maxMarginUsdt: 1000, maxDailyLossUsdt: 100, maxNetDelta: 1, maxOrdersPerDay: 10 };

function lazyCredentials() {
  // eslint-disable-next-line global-require
  const load = () => require('./options-credentials.service');
  return {
    getClientForUser: (...args) => load().getClientForUser(...args),
    getLimits: (...args) => load().getLimits(...args),
  };
}

function normalizeUnderlying(value) {
  const underlying = String(value || '').toUpperCase();
  if (!UNDERLYINGS.includes(underlying)) {
    throw new ValidationError(`Subyacente no soportado: ${value}. Opciones: ${UNDERLYINGS.join(', ')}`);
  }
  return underlying;
}

function normalizeLimits(raw = {}, base = DEFAULT_LIMITS) {
  const out = { ...base };
  for (const key of LIMIT_KEYS) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null || raw[key] === '') {
      out[key] = null;
      continue;
    }
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${key} debe ser un número ≥ 0 o null`);
    out[key] = key === 'maxOrdersPerDay' ? Math.floor(n) : n;
  }
  return out;
}

function round(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(Number(value) * f) / f;
}

/** Estadísticas de las operaciones cerradas de un libro (orden: cierre, luego id). */
function tradeStatsFor(closed) {
  const sorted = [...closed].sort((a, b) => a.closedAt - b.closedAt || a.id - b.id);
  let cum = 0; let peak = 0; let drawdown = 0; let streak = 0; let worst = 0; let sum = 0; let counted = 0;
  for (const p of sorted) {
    const pnl = Number.isFinite(p.pnlUsdt) ? p.pnlUsdt : null;
    if (pnl !== null) { cum += pnl; sum += pnl; counted += 1; }
    peak = Math.max(peak, cum);
    drawdown = Math.max(drawdown, peak - cum);
    if (pnl !== null && pnl < 0) { streak += 1; worst = Math.max(worst, streak); } else streak = 0;
  }
  return {
    closedTrades: sorted.length,
    avgPnlUsdt: counted ? round(sum / counted) : null,
    maxDrawdownUsdt: sorted.length ? round(drawdown) : null,
    longestLosingStreak: worst,
  };
}

/**
 * Comisiones por concepto. Las filas sin desglose (cerradas históricas)
 * suman su total en `unallocatedUsdt`; en las demás los NULL cuentan 0.
 */
function feeBreakdownFor(positions) {
  const acc = { entryUsdt: 0, exitUsdt: 0, exerciseUsdt: 0, unallocatedUsdt: 0 };
  for (const p of positions) {
    if (p.entryFeeUsdt == null && p.exitFeeUsdt == null && p.exerciseFeeUsdt == null) {
      acc.unallocatedUsdt += Number(p.feesUsdt) || 0;
      continue;
    }
    acc.entryUsdt += Number(p.entryFeeUsdt) || 0;
    acc.exitUsdt += Number(p.exitFeeUsdt) || 0;
    acc.exerciseUsdt += Number(p.exerciseFeeUsdt) || 0;
  }
  return {
    entryUsdt: round(acc.entryUsdt), exitUsdt: round(acc.exitUsdt),
    exerciseUsdt: round(acc.exerciseUsdt), unallocatedUsdt: round(acc.unallocatedUsdt),
  };
}

// `since` (ms epoch) opcional del detalle: vacío = sin filtro; inválido = 400.
function parseSince(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw)) ? Number(raw) : NaN);
  if (!Number.isSafeInteger(n) || n < 0) throw new ValidationError('El parámetro since debe ser una fecha en milisegundos (entero ≥ 0)');
  return n;
}

function kpisFor(positions, events, mode, now) {
  const mine = positions.filter((p) => p.mode === mode);
  const closed = mine.filter((p) => p.closedAt != null);
  // Un ciclo = las patas abiertas en el mismo instante.
  const cycles = new Map();
  for (const p of mine) {
    if (!cycles.has(p.openedAt)) cycles.set(p.openedAt, { pnl: 0, open: 0 });
    const c = cycles.get(p.openedAt);
    if (p.closedAt == null) c.open += 1;
    else c.pnl += p.pnlUsdt;
  }
  const finished = [...cycles.values()].filter((c) => c.open === 0);
  const premium = events
    .filter((e) => e.mode === mode && e.action === 'open')
    .reduce((acc, e) => acc + (e.premiumUsdt || 0), 0);
  return {
    realizedPnlUsdt: round(closed.reduce((a, p) => a + p.pnlUsdt, 0)),
    pnl30dUsdt: round(closed.filter((p) => p.closedAt >= now - 30 * DAY_MS).reduce((a, p) => a + p.pnlUsdt, 0)),
    feesUsdt: round(mine.reduce((a, p) => a + p.feesUsdt, 0)),
    feeBreakdown: feeBreakdownFor(mine),
    premiumUsdt: round(premium),
    feesPctOfPremium: premium > 0 ? round((mine.reduce((a, p) => a + p.feesUsdt, 0) / premium) * 100, 1) : null,
    cycles: cycles.size,
    winRatePct: finished.length ? round((finished.filter((c) => c.pnl > 0).length / finished.length) * 100, 1) : null,
    openPositions: mine.length - closed.length,
    ...tradeStatsFor(closed),
  };
}

/** Curva de PnL realizado acumulado: un punto por cierre, con ambos libros. */
function equityCurve(positions, startAt) {
  const closes = positions.filter((p) => p.closedAt != null).sort((a, b) => a.closedAt - b.closedAt);
  const acc = { shadow: 0, live: 0 };
  const points = [{ t: startAt, shadow: 0, live: 0 }];
  for (const p of closes) {
    acc[p.mode] += p.pnlUsdt;
    const last = points[points.length - 1];
    const point = { t: p.closedAt, shadow: round(acc.shadow), live: round(acc.live) };
    if (last.t === p.closedAt) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

const round2 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Consumo actual de los límites de la estrategia, con los mismos cálculos que
 * el runner aplica antes de enviar una orden. Mide el libro real si la
 * estrategia está en `live`, si no el de sombra. El margen y la delta piden
 * datos de mercado: si fallan quedan en null en vez de romper el detalle.
 */
async function limitsUsage({ repo, market, strategy, positions, at, quotes = new Map(), orders = [], shadowPending = [] }) {
  const mode = strategy.mode === 'live' ? 'live' : 'shadow';
  const since = utcDayStart(at);
  const open = positions.filter((p) => p.mode === mode && p.closedAt == null);
  const [pnlToday, ordersToday] = await Promise.all([
    repo.realizedPnlSince({ userId: strategy.userId, strategyId: strategy.id, mode, since }),
    repo.countOrdersSince(strategy.id, mode, since),
  ]);

  let marginUsedUsdt = null;
  let netDelta = null;
  // Spot por subyacente (un bot puede operar varios): cada posición y orden
  // se valora con el de su símbolo. Uno que falle queda sin spot (null).
  // Reservas de entradas pendientes del libro: órdenes reales o, en sombra,
  // las entradas simuladas (el mismo cálculo que el runner).
  const bookOrders = mode === 'live' ? orders : shadowEntriesAsOrders(shadowPending);
  const underlyings = new Set([String(strategy.underlying).toUpperCase()]);
  for (const item of [...open, ...bookOrders]) {
    const u = parseSymbol(item.symbol)?.underlying;
    if (u) underlyings.add(u);
  }
  const spots = {};
  await Promise.all([...underlyings].map(async (u) => {
    try { spots[u] = (await market.getChain(u))?.spot; } catch { spots[u] = undefined; }
  }));
  const spot = spots[String(strategy.underlying).toUpperCase()];
  try {
    marginUsedUsdt = 0;
    for (const p of open) {
      const meta = parseSymbol(p.symbol);
      if (!meta || p.side !== 'SELL') continue;
      marginUsedUsdt += estimateMargin({ ...p, type: meta.type, strike: meta.strike, price: p.entryPrice, spot: spots[meta.underlying] });
    }
    marginUsedUsdt = Number.isFinite(marginUsedUsdt) ? round2(marginUsedUsdt) : null;
  } catch { marginUsedUsdt = null; }
  try {
    // Delta en unidades del subyacente: sumar BTC con ETH no tiene sentido.
    if (new Set(open.map((p) => parseSymbol(p.symbol)?.underlying)).size > 1) throw new Error('varios subyacentes');
    if (open.some((p) => !quotes.get(p.id))) throw new Error('cotización no disponible');
    netDelta = round2(open.reduce((acc, p) => acc + legDeltaExposure({ side: p.side, delta: quotes.get(p.id)?.delta, quantity: p.quantity }), 0));
  } catch { netDelta = null; }

  // Comprometido del bot: el mismo cálculo que el runner pasa al template
  // (con o sin presupuesto: el KPI muestra lo «en uso»). `reservedUsdt` es
  // la parte de entradas pendientes.
  const total = computeCommitted({ positions: open, orders: bookOrders, spot, spots });
  const reserved = computeCommitted({ positions: [], orders: bookOrders, spot, spots });
  const committedUsdt = Number.isFinite(total) ? round2(total) : null;
  const reservedUsdt = committedUsdt !== null && Number.isFinite(reserved) ? round2(reserved) : null;

  return { mode, marginUsedUsdt, dailyLossUsdt: round2(Math.max(0, -pnlToday)), ordersToday, netDelta, committedUsdt, reservedUsdt };
}

function createOptionsStrategiesService(deps = {}) {
  const repo = deps.repo || defaultRepo;
  // En producción usa el ledger PostgreSQL. Los repositorios aislados que
  // se inyectan en pruebas no necesitan abrir una conexión real.
  const liveOrders = deps.liveOrders || (repo === defaultRepo
    ? require('../../repositories/options-live-orders.repository')
    : { listByStrategy: async () => [] });
  const shadowEntries = deps.shadowEntries || (repo === defaultRepo
    ? { listPending: (...args) => require('../../repositories/options-shadow-entries.repository').listPending(...args) }
    : { listPending: async () => [] });
  const credentials = deps.credentials || lazyCredentials();
  const market = deps.market || lazyMarket();
  const now = deps.now || Date.now;

  async function requireStrategy(userId, id) {
    const strategy = await repo.getStrategy(userId, id);
    if (!strategy) throw new NotFoundError('Estrategia no encontrada');
    return strategy;
  }

  /**
   * Listado con PnL 30 d, posiciones abiertas y estado. Por defecto excluye
   * los bots por alertas (`alert_signal`); `{ alertBots: true }` devuelve solo esos.
   */
  async function list(userId, { alertBots = false } = {}) {
    const [all, pnl, openCounts, lastEvents] = await Promise.all([
      repo.listStrategies(userId),
      repo.pnlByStrategySince(userId, now() - 30 * DAY_MS),
      repo.openCountsByStrategy(userId),
      repo.lastEventsByUser(userId),
    ]);
    const strategies = all.filter((s) => templates.isSignalDriven(s.template) === alertBots);
    return strategies.map((s) => {
      const pnl30d = { shadow: 0, live: 0 };
      for (const row of pnl) if (row.strategyId === s.id) pnl30d[row.mode] = round(row.pnlUsdt);
      const open = { shadow: 0, live: 0 };
      for (const row of openCounts) if (row.strategyId === s.id) open[row.mode] = row.count;
      const lastEvent = lastEvents.find((e) => e.strategyId === s.id) || null;
      let status = 'waiting';
      if (s.mode === 'paused') status = 'paused';
      else if (lastEvent?.action === 'error') status = 'error';
      else if (open[s.mode === 'live' ? 'live' : 'shadow'] > 0) status = 'in_position';
      return { ...s, pnl30d, openPositions: open, status, lastEvent };
    });
  }

  /** `opts.alertBots`: lo llama el servicio de bots por alertas, que ya validó las alertas. */
  async function create(userId, body = {}, opts = {}) {
    const template = templates.getTemplate(body.template);
    if (template.signalDriven && !opts.alertBots) {
      throw new ValidationError('Los bots por alertas se crean desde /options/auto-bots');
    }
    if (body.mode === 'live') {
      throw new ValidationError('Una estrategia nueva no puede nacer en modo real: créala en sombra y cámbiala con PUT /:id/mode');
    }
    const mode = body.mode || 'shadow';
    if (!['paused', 'shadow'].includes(mode)) throw new ValidationError(`Modo inválido: ${mode}`);
    const name = String(body.name || '').trim() || template.label;
    return repo.createStrategy({
      userId,
      name: name.slice(0, 120),
      template: template.id,
      underlying: normalizeUnderlying(body.underlying),
      params: templates.validateParams(template.id, body.params || {}),
      limits: normalizeLimits(body.limits || {}),
      mode,
    });
  }

  async function get(userId, id, { since: rawSince } = {}) {
    const since = parseSince(rawSince);
    const strategy = await requireStrategy(userId, id);
    const isBot = strategy.template === 'alert_signal';
    const [positions, events, standingOrders, shadowPending] = await Promise.all([
      repo.listPositions(strategy.id),
      repo.listEvents(strategy.id, { limit: 100 }),
      strategy.template === 'alert_signal'
        ? liveOrders.listByStrategy(strategy.id)
        : Promise.resolve([]),
      isBot ? shadowEntries.listPending({ strategyId: strategy.id }) : Promise.resolve([]),
    ]);
    const at = now();
    // Periodo: kpis, curva y cerradas solo cuentan lo abierto desde `since`.
    const inPeriod = since == null ? positions : positions.filter((p) => p.openedAt >= since);
    const periodEvents = since == null ? events : events.filter((e) => e.createdAt >= since);
    const periodKpis = (mode) => {
      const k = kpisFor(inPeriod, periodEvents, mode, at);
      return since == null ? k : { ...k, pnlPeriodUsdt: k.realizedPnlUsdt };
    };
    // Una sola cotización por posición abierta: alimenta el mark que ve el
    // cliente y la delta neta de los límites. Una que falle no rompe el detalle.
    const openNow = positions.filter((p) => p.closedAt == null);
    const quotes = new Map(await Promise.all(openNow.map(async (p) => {
      try { return [p.id, (await market.getQuote(p.symbol)) || null]; } catch { return [p.id, null]; }
    })));
    // Entradas esperando fill: sombra (tabla propia) y reales (órdenes `open` sin terminar).
    const pendingRaw = [
      ...shadowPending.map((e) => ({ id: e.id, mode: 'shadow', symbol: e.symbol, side: e.side, quantity: e.quantity,
        executedQty: 0, limitPrice: e.limitPrice, deadlineAt: e.deadlineAt, spot: e.spot })),
      ...standingOrders.filter((o) => o.action === 'open' && o.status !== 'final').map((o) => ({
        id: o.id, mode: 'live', symbol: o.symbol, side: o.side, quantity: o.quantity,
        executedQty: o.processedQty ?? 0, limitPrice: o.limitPrice, deadlineAt: o.deadlineAt ?? null, spot: null })),
    ];
    const pendingEntries = await Promise.all(pendingRaw.map(async ({ spot: entrySpot, ...e }) => {
      let q = null;
      try { q = (await market.getQuote(e.symbol)) || null; } catch { q = null; }
      let spot = entrySpot ?? q?.spot ?? null;
      if (spot == null) {
        try { spot = (await market.getChain(parseSymbol(e.symbol)?.underlying))?.spot ?? null; } catch { spot = null; }
      }
      const fee = spot != null ? tradeFee({ spot, quantity: e.quantity, price: e.limitPrice }) : null;
      return { ...e, bid: q?.bid ?? null, ask: q?.ask ?? null, feesEstUsdt: fee == null ? null : round(fee, 4) };
    }));
    return {
      ...strategy,
      pendingEntries,
      blockedUnderlyings: strategy.state?.blockedUnderlyings || {},
      kpis: { shadow: periodKpis('shadow'), live: periodKpis('live') },
      equity: equityCurve(inPeriod, since ?? strategy.createdAt),
      positions: openNow.map((p) => {
        const q = quotes.get(p.id);
        return { ...p, mark: q?.mark ?? null, bid: q?.bid ?? null, ask: q?.ask ?? null };
      }),
      // Solo información operacional; las credenciales nunca llegan al cliente.
      takeProfitOrders: standingOrders.filter((o) => o.purpose === 'take_profit')
        .slice(0, 20).map((o) => ({
          id: o.id, positionId: o.positionId, symbol: o.symbol,
          price: o.limitPrice, quantity: o.quantity, executedQty: o.processedQty,
          status: o.status, cancelRequested: o.cancelRequested,
        })),
      ...(strategy.template === 'alert_signal' ? { pendingOrders: standingOrders.filter((o) => o.status !== 'final').slice(0, 50).map((o) => ({
        id: o.id, purpose: o.purpose, action: o.action, symbol: o.symbol, side: o.side,
        price: o.limitPrice, quantity: o.quantity, executedQty: o.processedQty,
        status: o.status, cancelRequested: o.cancelRequested,
        createdAt: o.createdAt, deadlineAt: o.deadlineAt, error: o.error ?? null,
      })) } : {}),
      closedPositions: inPeriod.filter((p) => p.closedAt != null)
        .sort((a, b) => b.closedAt - a.closedAt || b.id - a.id).slice(0, 50).map((p) => ({
          id: p.id, mode: p.mode, symbol: p.symbol, side: p.side, quantity: p.quantity,
          entryPrice: p.entryPrice, exitPrice: p.exitPrice, openedAt: p.openedAt,
          closedAt: p.closedAt, pnlUsdt: p.pnlUsdt, feesUsdt: p.feesUsdt,
          closeReason: p.closeReason ?? null,
          entryFeeUsdt: p.entryFeeUsdt ?? null, exitFeeUsdt: p.exitFeeUsdt ?? null,
          exerciseFeeUsdt: p.exerciseFeeUsdt ?? null,
          premiumRange: p.premiumRange ?? null,
          tpTargetPrice: p.tpTargetPrice ?? null, tpTargetMeta: p.tpTargetMeta ?? null,
        })),
      usage: await limitsUsage({ repo, market, strategy, positions, at, quotes, orders: standingOrders, shadowPending }),
      events,
    };
  }

  async function update(userId, id, body = {}, opts = {}) {
    const strategy = await requireStrategy(userId, id);
    if (templates.isSignalDriven(strategy.template) && !opts.alertBots
      && (body.underlying !== undefined || (body.params && (body.params.alertIds !== undefined || body.params.underlyings !== undefined)))) {
      throw new ValidationError('Las alertas y el subyacente de un bot se editan desde /options/auto-bots');
    }
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) throw new ValidationError('El nombre no puede estar vacío');
      patch.name = name.slice(0, 120);
    }
    if (body.params !== undefined) {
      patch.params = templates.validateParams(strategy.template, { ...strategy.params, ...(body.params || {}) });
      // La banda ATR anula stop y salida por tiempo, y el runner no calcula
      // objetivo para posiciones reales ya abiertas: quedarían sin salida.
      if (patch.params.takeProfitMode === 'atr_band' && strategy.params?.takeProfitMode !== 'atr_band' &&
          (await repo.listOpenPositions(strategy.id, 'live')).length) {
        throw new AppError('Cierra las posiciones reales abiertas antes de cambiar a venta por banda ATR',
          { status: 409, code: 'OPEN_LIVE_POSITIONS' });
      }
    }
    if (body.limits !== undefined) patch.limits = normalizeLimits(body.limits || {}, { ...DEFAULT_LIMITS, ...strategy.limits });
    if (body.underlying !== undefined) {
      const underlying = normalizeUnderlying(body.underlying);
      if (underlying !== strategy.underlying) {
        const open = (await repo.listOpenPositions(strategy.id, 'shadow')).length + (await repo.listOpenPositions(strategy.id, 'live')).length;
        if (open) throw new AppError('No se puede cambiar el subyacente con posiciones abiertas', { status: 409, code: 'OPEN_POSITIONS' });
        patch.underlying = underlying;
      }
    }
    return repo.updateStrategy(userId, id, patch);
  }

  async function setMode(userId, id, { mode, confirm } = {}) {
    if (!MODES.includes(mode)) throw new ValidationError(`Modo inválido: ${mode}`);
    const strategy = await requireStrategy(userId, id);
    if (mode === 'live' && strategy.mode !== 'live') {
      if (confirm !== true) {
        throw new AppError('Pasar a modo real envía órdenes reales: confirma con confirm: true', { status: 400, code: 'LIVE_CONFIRM_REQUIRED' });
      }
      try {
        await credentials.getClientForUser(userId);
      } catch {
        throw new AppError('Configura la API key de Binance Opciones en Configuración antes de activar el modo real', { status: 400, code: 'OPTIONS_CREDENTIALS_MISSING' });
      }
      let limits;
      try {
        limits = (await credentials.getLimits(userId)) || {};
      } catch {
        throw new AppError('No se pudieron leer los límites globales de opciones', { status: 400, code: 'OPTIONS_LIMITS_UNAVAILABLE' });
      }
      const max = Number(limits.maxLiveStrategies);
      const current = await repo.countLiveStrategies(userId, strategy.id);
      if (!Number.isFinite(max) || current >= max) {
        throw new AppError(`Ya tienes ${current} estrategia(s) en modo real; el máximo configurado es ${Number.isFinite(max) ? max : 0}`, { status: 400, code: 'MAX_LIVE_STRATEGIES' });
      }
    }
    if (strategy.mode === 'live' && mode !== 'live') {
      // Fuera de Real el runner y el monitor de TP/salidas ya no ven la
      // estrategia: sus posiciones reales se quedarían sin stop ni TP.
      const orders = await liveOrders.listByStrategy(strategy.id);
      if (orders.some((o) => o.status !== 'final')) {
        throw new AppError('La estrategia tiene órdenes reales pendientes de conciliación', { status: 409, code: 'PENDING_LIVE_ORDERS' });
      }
      const live = await repo.listOpenPositions(strategy.id, 'live');
      if (live.length) {
        throw new AppError('La estrategia tiene posiciones reales abiertas: ciérralas antes de sacarla de modo real', { status: 409, code: 'OPEN_LIVE_POSITIONS' });
      }
    }
    return repo.setMode(userId, id, mode);
  }

  async function remove(userId, id) {
    const strategy = await requireStrategy(userId, id);
    const orders = await liveOrders.listByStrategy(strategy.id);
    if (orders.some((o) => o.status !== 'final')) {
      throw new AppError('La estrategia tiene órdenes reales pendientes de conciliación', { status: 409, code: 'PENDING_LIVE_ORDERS' });
    }
    if (orders.length) {
      throw new AppError('Una estrategia con historial de órdenes reales no se puede borrar: conservar auditoría', { status: 409, code: 'LIVE_ORDER_AUDIT_REQUIRED' });
    }
    const live = await repo.listOpenPositions(strategy.id, 'live');
    if (live.length) {
      throw new AppError('La estrategia tiene posiciones reales abiertas: ciérralas antes de borrarla', { status: 409, code: 'OPEN_LIVE_POSITIONS' });
    }
    await repo.deleteStrategy(userId, id);
    return { id };
  }

  return {
    listTemplates: () => templates.listTemplates(),
    list,
    create,
    get,
    update,
    setMode,
    remove,
  };
}

module.exports = createOptionsStrategiesService();
module.exports.createOptionsStrategiesService = createOptionsStrategiesService;
module.exports.DEFAULT_LIMITS = DEFAULT_LIMITS;
module.exports.kpisFor = kpisFor;
