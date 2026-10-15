/**
 * Gestión de estrategias de opciones (CRUD, cambio de modo y vistas con KPIs).
 * El paso a `live` exige confirmación explícita, credenciales de Binance
 * Opciones y no superar `maxLiveStrategies` de los límites globales.
 */

const { AppError, ValidationError, NotFoundError } = require('../../errors/app-error');
const defaultRepo = require('../../repositories/options-strategies.repository');
const templates = require('./templates');
const { UNDERLYINGS } = require('./options-iv-recorder.service');
const { DAY_MS, parseSymbol } = require('./options-utils');
const { estimateMargin, legDeltaExposure, utcDayStart, lazyMarket } = require('./options-strategy-runner.service');

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
    premiumUsdt: round(premium),
    cycles: cycles.size,
    winRatePct: finished.length ? round((finished.filter((c) => c.pnl > 0).length / finished.length) * 100, 1) : null,
    openPositions: mine.length - closed.length,
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
async function limitsUsage({ repo, market, strategy, positions, at }) {
  const mode = strategy.mode === 'live' ? 'live' : 'shadow';
  const since = utcDayStart(at);
  const open = positions.filter((p) => p.mode === mode && p.closedAt == null);
  const [pnlToday, ordersToday] = await Promise.all([
    repo.realizedPnlSince({ userId: strategy.userId, strategyId: strategy.id, mode, since }),
    repo.countOrdersSince(strategy.id, mode, since),
  ]);

  let marginUsedUsdt = null;
  let netDelta = null;
  try {
    const { spot } = await market.getChain(strategy.underlying);
    marginUsedUsdt = 0;
    for (const p of open) {
      const meta = parseSymbol(p.symbol);
      if (!meta || p.side !== 'SELL') continue;
      marginUsedUsdt += estimateMargin({ ...p, type: meta.type, strike: meta.strike, price: p.entryPrice, spot });
    }
    marginUsedUsdt = round2(marginUsedUsdt);
  } catch { marginUsedUsdt = null; }
  try {
    const quotes = await Promise.all(open.map((p) => market.getQuote(p.symbol)));
    netDelta = round2(open.reduce((acc, p, i) => acc + legDeltaExposure({ side: p.side, delta: quotes[i]?.delta, quantity: p.quantity }), 0));
  } catch { netDelta = null; }

  return { mode, marginUsedUsdt, dailyLossUsdt: round2(Math.max(0, -pnlToday)), ordersToday, netDelta };
}

function createOptionsStrategiesService(deps = {}) {
  const repo = deps.repo || defaultRepo;
  const credentials = deps.credentials || lazyCredentials();
  const market = deps.market || lazyMarket();
  const now = deps.now || Date.now;

  async function requireStrategy(userId, id) {
    const strategy = await repo.getStrategy(userId, id);
    if (!strategy) throw new NotFoundError('Estrategia no encontrada');
    return strategy;
  }

  async function list(userId) {
    const [strategies, pnl, openCounts, lastEvents] = await Promise.all([
      repo.listStrategies(userId),
      repo.pnlByStrategySince(userId, now() - 30 * DAY_MS),
      repo.openCountsByStrategy(userId),
      repo.lastEventsByUser(userId),
    ]);
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

  async function create(userId, body = {}) {
    const template = templates.getTemplate(body.template);
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

  async function get(userId, id) {
    const strategy = await requireStrategy(userId, id);
    const [positions, events] = await Promise.all([
      repo.listPositions(strategy.id),
      repo.listEvents(strategy.id, { limit: 100 }),
    ]);
    const at = now();
    return {
      ...strategy,
      kpis: { shadow: kpisFor(positions, events, 'shadow', at), live: kpisFor(positions, events, 'live', at) },
      equity: equityCurve(positions, strategy.createdAt),
      positions: positions.filter((p) => p.closedAt == null),
      usage: await limitsUsage({ repo, market, strategy, positions, at }),
      events,
    };
  }

  async function update(userId, id, body = {}) {
    const strategy = await requireStrategy(userId, id);
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) throw new ValidationError('El nombre no puede estar vacío');
      patch.name = name.slice(0, 120);
    }
    if (body.params !== undefined) {
      patch.params = templates.validateParams(strategy.template, { ...strategy.params, ...(body.params || {}) });
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
    return repo.setMode(userId, id, mode);
  }

  async function remove(userId, id) {
    const strategy = await requireStrategy(userId, id);
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
