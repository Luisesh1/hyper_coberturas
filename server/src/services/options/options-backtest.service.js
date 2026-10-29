/**
 * Backtesting de estrategias de opciones.
 *
 * Fuentes de precios:
 * - `recorded`: snapshots horarios de la cadena grabados por la app.
 * - `dvol`: Black-Scholes con el DVOL histórico de Deribit como IV ATM (solo
 *   BTC/ETH) y sonrisa fija.
 * - `realized`: volatilidad realizada a 30 días de las velas spot de Binance
 *   más una prima configurable (`volPremiumPct`).
 *
 * En cada paso horario se construye la cadena y se corre el mismo `evaluate`
 * del template que usa el runner. Se ejecuta en una cola asíncrona: la tarea
 * se guarda `queued` → `running` → `done | failed` en `options_backtests`.
 */

const logger = require('../logger.service');
const { AppError, ValidationError, NotFoundError } = require('../../errors/app-error');
const { botUnderlyings } = require('./bot-underlyings');
const templates = require('./templates');
const { intrinsic } = require('./options-pricing');
const { buildSyntheticChain, syntheticExpiries, syntheticLeg } = require('./options-synthetic-chain');
const { wilderAtrBands, atrBandTakeProfit } = require('./options-atr-band-tp');
const { committedUsdt } = require('./options-committed-capital');
const {
  HOUR_MS,
  DAY_MS,
  TRADE_FEE_RATE_PCT,
  parseSymbol,
  fillPrice,
  tradeFee,
  exerciseFee,
  signedPremium,
  grossPnl,
  ivToDecimal,
  num,
} = require('./options-utils');

const SOURCES = ['recorded', 'dvol', 'realized'];
const SIGNAL_SOURCES = ['dvol', 'realized'];
const DVOL_UNDERLYINGS = ['BTC', 'ETH'];
const MAX_RANGE_DAYS = 365;
const REALIZED_WINDOW_HOURS = 30 * 24;
const HOURS_PER_YEAR = 365 * 24;
const MAX_PENDING_PER_USER = 3;
const MAX_EQUITY_POINTS = 400;
const DERIBIT_DVOL_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const DEFAULTS = { capitalUsdt: 10000, spreadPct: 5, feePct: TRADE_FEE_RATE_PCT, volPremiumPct: 10 };

const round = (value, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round(Number(value) * f) / f;
};

function toMs(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : (/^\d+$/.test(String(value)) ? Number(value) : Date.parse(value));
  return Number.isFinite(n) ? n : null;
}

// ---------- fuentes de datos ----------

/** DVOL horario de Deribit (decimal), paginando con `continuation`. */
async function fetchDvol({ currency, from, to, fetchImpl = fetch }) {
  const points = new Map();
  let end = to;
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({
      currency,
      start_timestamp: String(Math.floor(from)),
      end_timestamp: String(Math.floor(end)),
      resolution: '3600',
    });
    const res = await fetchImpl(`${DERIBIT_DVOL_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new AppError(`Deribit respondió ${res.status} al pedir el DVOL`, { status: 502, code: 'EXTERNAL_SERVICE_ERROR' });
    const body = await res.json();
    const data = body?.result?.data || [];
    for (const row of data) {
      const ts = Number(row[0]);
      const close = ivToDecimal(row[4]);
      if (Number.isFinite(ts) && close != null) points.set(ts, close);
    }
    const continuation = Number(body?.result?.continuation);
    if (!data.length || !Number.isFinite(continuation) || continuation <= from || continuation >= end) break;
    end = continuation;
  }
  return [...points.entries()].sort((a, b) => a[0] - b[0]).map(([t, iv]) => ({ t, iv }));
}

/** Volatilidad realizada anualizada sobre una ventana móvil de retornos log horarios. */
function realizedVolSeries(candles, windowHours = REALIZED_WINDOW_HOURS) {
  const out = new Array(candles.length).fill(null);
  const returns = [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const r = Math.log(candles[i].close / candles[i - 1].close);
    returns.push(r);
    sum += r;
    sumSq += r * r;
    if (returns.length > windowHours) {
      const old = returns[returns.length - windowHours - 1];
      sum -= old;
      sumSq -= old * old;
    }
    const n = Math.min(returns.length, windowHours);
    if (n >= 24) {
      const mean = sum / n;
      const variance = Math.max(0, (sumSq - n * mean * mean) / (n - 1));
      out[i] = Math.sqrt(variance * HOURS_PER_YEAR);
    }
  }
  return out;
}

/** Último valor con t ≤ objetivo (o el primero si aún no hay ninguno). */
function forwardFill(series) {
  let idx = 0;
  return (t) => {
    while (idx + 1 < series.length && series[idx + 1].t <= t) idx += 1;
    return series[idx]?.iv ?? null;
  };
}

// ---------- pasos de simulación ----------

/** Pasos sintéticos: cadena BS con IV ATM `iv` en cada vela. */
function syntheticSteps({ underlying, candles, ivAt, spreadPct }) {
  return candles.map((candle) => {
    const t = candle.time + HOUR_MS;
    const spot = candle.close;
    const atmIv = ivAt(t);
    return {
      t,
      spot,
      chainFor(days) {
        if (!(atmIv > 0)) return null;
        const expiry = templates.pickExpiry(syntheticExpiries(t), days);
        return expiry ? buildSyntheticChain({ underlying, spot, now: t, expiry, atmIv, spreadPct }) : null;
      },
      quote(symbol) {
        const meta = parseSymbol(symbol);
        if (!meta || !(atmIv > 0) || meta.expiryMs <= t) return null;
        return syntheticLeg({ underlying, expiry: meta.expiry, expiryMs: meta.expiryMs, strike: meta.strike, type: meta.type, spot, now: t, atmIv, spreadPct });
      },
    };
  });
}

/** Pasos desde snapshots grabados: precios reales; lo que falte, BS con la IV ATM del snapshot. */
function recordedSteps({ underlying, snapshots }) {
  const byTime = new Map();
  for (const s of snapshots) {
    if (!byTime.has(s.capturedAt)) byTime.set(s.capturedAt, []);
    byTime.get(s.capturedAt).push(s);
  }
  const toLeg = (s) => s && ({ symbol: s.symbol, bid: s.bid, ask: s.ask, mark: s.mark, iv: s.iv, delta: s.delta });
  return [...byTime.keys()].sort((a, b) => a - b).map((t) => {
    const rows = byTime.get(t);
    const spot = rows[0].spot;
    const bySymbol = new Map(rows.map((s) => [s.symbol, s]));
    const byExpiry = new Map();
    for (const s of rows) {
      if (!byExpiry.has(s.expiry)) byExpiry.set(s.expiry, []);
      byExpiry.get(s.expiry).push(s);
    }
    const expiries = [...byExpiry.keys()]
      .map((code) => ({ code, expiryMs: parseSymbol(`X-${code}-1-C`).expiryMs }))
      .filter((e) => e.expiryMs > t)
      .map((e) => ({ ...e, dte: (e.expiryMs - t) / DAY_MS }));
    // IV ATM del vencimiento más cercano, para valorar patas sin snapshot.
    const nearest = expiries.slice().sort((a, b) => a.dte - b.dte)[0];
    let atmIv = null;
    if (nearest) {
      const atm = byExpiry.get(nearest.code).filter((s) => s.iv > 0)
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
      atmIv = atm ? atm.iv : null;
    }
    return {
      t,
      spot,
      chainFor(days) {
        const pick = templates.pickExpiry(expiries, days);
        if (!pick) return null;
        const strikes = new Map();
        for (const s of byExpiry.get(pick.code)) {
          if (!strikes.has(s.strike)) strikes.set(s.strike, { strike: s.strike, call: null, put: null });
          strikes.get(s.strike)[s.type === 'C' ? 'call' : 'put'] = toLeg(s);
        }
        const chainRows = [...strikes.values()].sort((a, b) => a.strike - b.strike);
        return { underlying, spot, expiry: pick.code, expiryMs: pick.expiryMs, rows: chainRows };
      },
      quote(symbol) {
        const hit = bySymbol.get(symbol);
        if (hit) return toLeg(hit);
        const meta = parseSymbol(symbol);
        if (!meta || !(atmIv > 0) || meta.expiryMs <= t) return null;
        return syntheticLeg({ underlying, expiry: meta.expiry, expiryMs: meta.expiryMs, strike: meta.strike, type: meta.type, spot, now: t, atmIv, spreadPct: 0 });
      },
    };
  });
}

// ---------- motor ----------

function maxDrawdownPct(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

function sharpe(dailyEquity) {
  const rets = [];
  for (let i = 1; i < dailyEquity.length; i += 1) {
    if (dailyEquity[i - 1] > 0) rets.push(dailyEquity[i] / dailyEquity[i - 1] - 1);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(365) : 0;
}

/** Velas {time, open, high, low, close, closeTime?} → filas Binance [openTime, o, h, l, c, v, closeTime]. */
function candleRows(candles) {
  return (candles || []).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume ?? 0, c.closeTime ?? c.time + HOUR_MS - 1]);
}

/**
 * Objetivo de venta por banda ATR al abrir (como options-atr-band-target):
 * velas de 1h cerradas antes de `t` (las mismas que pide el mercado en vivo:
 * máx(200, longitud × 10), tope 500), spot del paso y prima del fill.
 * La cadena sintética no tiene tick: 0.0001 desde 0. null si no hay banda.
 */
function atrBandTarget({ rows, t, spot, fillPrice, type, params }) {
  const length = params.atrBandLength;
  const limit = Math.min(500, Math.max(200, length * 10));
  let end = rows.length;
  while (end > 0 && !(rows[end - 1][6] < t)) end -= 1;
  const band = wilderAtrBands(rows.slice(Math.max(0, end - limit), end), { length, multiplier: params.atrBandMultiplier, now: t });
  if (!band) return null;
  const tp = atrBandTakeProfit({ fillPrice, spot, type, band, tickSize: 0.0001, minPrice: 0, maxGainPct: params.tpMaxGainPct });
  return tp ? tp.price : null;
}

const utcDay = (t) => Math.floor(t / DAY_MS);

/**
 * Corre la simulación sobre `steps`. Puro: no hace E/S.
 * `feePct` es la tasa sobre el nocional del subyacente (tope: 10 % de la prima).
 *
 * Bots por alertas (`signals` = [{ t, direction, alertId }] ordenadas): en cada
 * paso, las señales con `prevT < s.t ≤ step.t` se evalúan una a una como
 * `ctx.signal` (antes de las salidas del paso) y `ctx.tradesToday` cuenta las
 * aperturas del día UTC. Con `takeProfitMode = 'atr_band'` el objetivo se fija
 * al abrir con `candles` (velas de 1h).
 */
function simulate({ template, params: rawParams, steps, capitalUsdt, feePct, signals = [], candles = [] }) {
  if (steps.length < 2) throw new ValidationError('No hay datos suficientes en el rango elegido');
  const s0 = steps[0].spot;
  const params = { ...rawParams };
  const holding = template.holdsSpot ? capitalUsdt / s0 : 0;
  if (template.holdsSpot) params.holdingQty = holding;
  const atrBand = params.takeProfitMode === 'atr_band';
  const atrRows = atrBand ? candleRows(candles) : null;

  let cash = 0;
  let seq = 1;
  let lastOpenedAt = null;
  let tradesDay = null;
  let tradesToday = 0;
  let signalIdx = 0;
  const signalStats = { received: 0, traded: 0, ignored: 0 };
  const positions = [];
  const cycles = [];
  const equity = [];
  const daily = [];
  const fee = (spot, quantity, price) => tradeFee({ spot, quantity, price, ratePct: feePct });

  function closePosition(position, price, feeUsdt, t, reason) {
    cash += signedPremium(position.side === 'SELL' ? 'BUY' : 'SELL', price, position.quantity) - feeUsdt;
    const pnl = grossPnl({ side: position.side, entryPrice: position.entryPrice, exitPrice: price, quantity: position.quantity }) - position.fee - feeUsdt;
    const cycle = position.cycle;
    cycle.pnl += pnl;
    cycle.fees += feeUsdt;
    cycle.openLegs -= 1;
    if (cycle.openLegs === 0) {
      cycle.closedAt = t;
      cycle.exitReason = reason;
    }
    positions.splice(positions.indexOf(position), 1);
  }

  /** Evalúa el template (con señal o sin ella) y aplica sus acciones. Devuelve cuántas se ejecutaron. */
  function evaluateAndApply(step, chainFor, signal) {
    const { t, spot } = step;
    const enriched = positions.map((p) => ({ ...p, quote: step.quote(p.symbol) }));
    const ctx = { now: t, underlying: null, spot, positions: enriched, params, lastOpenedAt };
    if (signal) {
      ctx.signal = signal;
      ctx.tradesToday = tradesToday;
      // Presupuesto total del bot: lo comprometido por las posiciones abiertas.
      if (params.budgetUsdt != null) ctx.committedUsdt = committedUsdt({ positions, spot });
    }
    // La cadena es perezosa: si el template no la mira, no se calcula.
    Object.defineProperty(ctx, 'chain', { enumerable: true, get: chainFor });

    let booked = 0;
    for (const action of template.evaluate(ctx)) {
      if (action.type === 'open') {
        const cycle = { openedAt: t, expiry: action.legs[0]?.expiry || null, legs: [], premium: 0, pnl: 0, fees: 0, openLegs: 0, closedAt: null, exitReason: null };
        for (const leg of action.legs) {
          const price = num(leg.price);
          if (!(price > 0)) continue;
          const f = fee(spot, leg.quantity, price);
          cash += signedPremium(leg.side, price, leg.quantity) - f;
          const meta = parseSymbol(leg.symbol);
          const position = { id: seq++, symbol: leg.symbol, side: leg.side, quantity: leg.quantity, entryPrice: price, fee: f, openedAt: t, ...meta, cycle };
          if (atrBand) position.tpTargetPrice = atrBandTarget({ rows: atrRows, t, spot, fillPrice: price, type: meta?.type, params });
          positions.push(position);
          cycle.legs.push({ symbol: leg.symbol, side: leg.side, quantity: leg.quantity, price: round(price, 4) });
          cycle.premium += signedPremium(leg.side, price, leg.quantity);
          cycle.fees += f;
          cycle.openLegs += 1;
        }
        if (cycle.openLegs) {
          cycles.push(cycle);
          lastOpenedAt = t;
          tradesToday += 1;
          booked += 1;
        }
      } else if (action.type === 'close') {
        for (const leg of action.legs) {
          const position = positions.find((p) => p.id === leg.positionId);
          if (!position) continue;
          const quote = enriched.find((p) => p.id === position.id)?.quote;
          const price = fillPrice(quote, leg.side) ?? num(quote?.mark) ?? intrinsic({ S: spot, K: position.strike, type: position.type });
          closePosition(position, price, fee(spot, position.quantity, price), t, action.reason);
          booked += 1;
        }
      }
    }
    return booked;
  }

  let prevT = -Infinity;
  for (const step of steps) {
    const { t, spot } = step;
    if (tradesDay !== utcDay(t)) {
      tradesDay = utcDay(t);
      tradesToday = 0;
    }

    // Vencimientos: liquidación europea contra el spot del paso.
    for (const p of positions.filter((x) => x.expiryMs <= t)) {
      const value = intrinsic({ S: spot, K: p.strike, type: p.type });
      closePosition(p, value, exerciseFee({ spot, quantity: p.quantity, intrinsicValue: value }), t, 'expiry');
    }

    let chainCache;
    const chainFor = () => {
      if (chainCache === undefined) chainCache = step.chainFor(params.expiryDays);
      return chainCache;
    };

    // Disparos de alertas del intervalo (prevT, t], uno a uno.
    while (signalIdx < signals.length && signals[signalIdx].t <= t) {
      const signal = signals[signalIdx];
      signalIdx += 1;
      if (!(signal.t > prevT)) continue;
      signalStats.received += 1;
      if (evaluateAndApply(step, chainFor, signal) > 0) signalStats.traded += 1;
      else signalStats.ignored += 1;
    }
    prevT = t;

    evaluateAndApply(step, chainFor, null);

    // Valor de mercado de lo abierto (al mark).
    let mtm = 0;
    for (const p of positions) {
      const q = step.quote(p.symbol);
      const mark = num(q?.mark) ?? intrinsic({ S: spot, K: p.strike, type: p.type });
      mtm += (p.side === 'BUY' ? 1 : -1) * mark * p.quantity;
    }
    const value = capitalUsdt + holding * (spot - s0) + cash + mtm;
    const hodl = capitalUsdt * (spot / s0);
    equity.push({ t, strategy: value, hodl, mtm });
    if (daily.length === 0 || t - daily[daily.length - 1].t >= DAY_MS) daily.push({ t, value });
  }

  // Ciclos abiertos al final: se valoran a mercado.
  const last = equity[equity.length - 1];
  for (const p of positions) {
    const q = steps[steps.length - 1].quote(p.symbol);
    const mark = num(q?.mark) ?? intrinsic({ S: steps[steps.length - 1].spot, K: p.strike, type: p.type });
    p.cycle.pnl += grossPnl({ side: p.side, entryPrice: p.entryPrice, exitPrice: mark, quantity: p.quantity }) - p.fee;
    p.cycle.exitReason = 'open';
  }

  const finalValue = last.strategy;
  if (daily[daily.length - 1].t !== last.t) daily.push({ t: last.t, value: finalValue });
  const closedPnls = cycles.map((c) => c.pnl);
  const stride = Math.max(1, Math.ceil(equity.length / MAX_EQUITY_POINTS));
  const sampled = equity.filter((_, i) => i % stride === 0 || i === equity.length - 1);

  return {
    metrics: {
      returnPct: round((finalValue / capitalUsdt - 1) * 100),
      pnlUsdt: round(finalValue - capitalUsdt),
      maxDrawdownPct: round(maxDrawdownPct(equity.map((e) => e.strategy))),
      sharpe: round(sharpe(daily.map((d) => d.value))),
      wins: cycles.filter((c) => c.pnl > 0).length,
      cycles: cycles.length,
      premiumUsdt: round(cycles.reduce((a, c) => a + c.premium, 0)),
      worstCycleUsdt: closedPnls.length ? round(Math.min(...closedPnls)) : 0,
    },
    equity: sampled.map((e) => ({ t: e.t, strategy: round(e.strategy), hodl: round(e.hodl) })),
    cycles: cycles.map((c) => ({
      openedAt: c.openedAt,
      expiry: c.expiry,
      legs: c.legs,
      premiumUsdt: round(c.premium),
      exitAt: c.closedAt,
      exitReason: c.exitReason,
      pnlUsdt: round(c.pnl),
      feesUsdt: round(c.fees),
    })),
    ...(template.signalDriven ? { signals: signalStats } : {}),
  };
}

function sourceNote(config, extra = {}) {
  const costs = `Spread ${config.spreadPct} % y comisión ${config.feePct} % del nocional (tope 10 % de la prima).`;
  if (config.source === 'recorded') {
    return `Precios reales de la cadena grabados por la app (${extra.snapshots || 0} snapshots horarios) con su bid/ask; las patas sin snapshot se valoran con Black-Scholes. Comisión ${config.feePct} % del nocional (tope 10 % de la prima).`;
  }
  const base = 'Estimación: Binance no publica precios de opciones vencidas, así que las primas son sintéticas (Black-Scholes con sonrisa fija)';
  if (config.source === 'dvol') return `${base} usando el DVOL histórico de Deribit como IV ATM. ${costs}`;
  return `${base} usando la volatilidad realizada a 30 días de las velas spot de Binance + ${config.volPremiumPct} % de prima. ${costs}`;
}

// ---------- servicio ----------

function lazyGetCandles() {
  // eslint-disable-next-line global-require
  return (...args) => require('../market-data.service').getCandles(...args);
}

function createOptionsBacktestService(deps = {}) {
  // eslint-disable-next-line global-require
  const repo = deps.repo || require('../../repositories/options-backtests.repository');
  // eslint-disable-next-line global-require
  const snapshotsRepo = deps.snapshotsRepo || require('../../repositories/options-iv-snapshots.repository');
  // eslint-disable-next-line global-require
  const strategiesRepo = deps.strategiesRepo || require('../../repositories/options-strategies.repository');
  // eslint-disable-next-line global-require
  const alertsRepo = deps.alertsRepo || require('../../repositories/alerts.repository');
  const getCandles = deps.getCandles || lazyGetCandles();
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const log = deps.logger || logger;
  const now = deps.now || Date.now;

  const queue = [];
  let processing = false;
  let idle = Promise.resolve();

  async function normalizeConfig(userId, input = {}) {
    let template;
    let params;
    let underlying = input.underlying ? String(input.underlying).toUpperCase() : null;
    let strategyId = null;
    let strategy = null;
    if (input.strategyId != null) {
      strategy = await strategiesRepo.getStrategy(userId, Number(input.strategyId));
      if (!strategy) throw new NotFoundError('Estrategia no encontrada');
      strategyId = strategy.id;
      template = strategy.template;
      params = { ...strategy.params, ...(input.params || {}) };
      underlying = underlying || strategy.underlying;
    } else {
      if (!input.template) throw new ValidationError('Indica strategyId o template');
      template = input.template;
      params = input.params || {};
    }
    templates.getTemplate(template);
    const signalDriven = templates.isSignalDriven(template);
    if (signalDriven && strategyId == null) {
      throw new ValidationError('Para backtestear un bot por alertas indica su strategyId');
    }
    params = templates.validateParams(template, params);
    if (!underlying) throw new ValidationError('underlying es obligatorio');
    // Bot multi-subyacente: se backtestea un subyacente del bot a la vez
    // (por defecto el primero, que es la columna `underlying`). El conjunto
    // sale del bot guardado: los params del input no lo amplían.
    if (signalDriven) {
      const own = botUnderlyings(strategy);
      if (!own.includes(underlying)) {
        throw new ValidationError(`El bot no opera ${underlying}. Opciones: ${own.join(', ')}`);
      }
    }

    const source = input.source || 'realized';
    if (!SOURCES.includes(source)) throw new ValidationError(`Fuente inválida: ${source}`);
    if (source === 'dvol' && !DVOL_UNDERLYINGS.includes(underlying)) {
      throw new ValidationError('La fuente DVOL solo existe para BTC y ETH');
    }
    if (signalDriven) {
      if (!SIGNAL_SOURCES.includes(source)) {
        throw new ValidationError('Los bots por alertas solo se backtestean con DVOL o volatilidad realizada: los precios grabados aún no están disponibles para ellos');
      }
      if (params.takeProfitMode === 'atr_band' && params.atrBandInterval !== '1h') {
        throw new ValidationError('El backtest de venta por banda ATR solo admite velas de 1h por ahora');
      }
      if (!params.alertIds?.length) throw new ValidationError('El bot no tiene alertas asignadas');
    }

    const to = toMs(input.to) ?? now();
    const from = toMs(input.from) ?? to - 90 * DAY_MS;
    if (!(from < to)) throw new ValidationError('from debe ser anterior a to');
    if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new ValidationError(`El rango máximo es de ${MAX_RANGE_DAYS} días`);
    if (to - from < 2 * DAY_MS) throw new ValidationError('El rango mínimo es de 2 días');

    const fromH = Math.floor(from / HOUR_MS) * HOUR_MS;
    const toH = Math.floor(to / HOUR_MS) * HOUR_MS;
    if (signalDriven) {
      const signals = await alertsRepo.listAlertSignals({ userId, alertIds: params.alertIds, underlying, from: fromH, to: toH });
      if (!signals.length) {
        const day = (ms) => new Date(ms).toISOString().slice(0, 10);
        throw new ValidationError(`Las alertas de este bot no se dispararon entre ${day(fromH)} y ${day(toH)}`);
      }
    }

    const pick = (key, min, max) => {
      const value = input[key] == null ? DEFAULTS[key] : Number(input[key]);
      if (!Number.isFinite(value) || value < min || value > max) throw new ValidationError(`${key} fuera de rango (${min}–${max})`);
      return value;
    };
    return {
      strategyId,
      template,
      params,
      underlying,
      source,
      from: fromH,
      to: toH,
      // Los bots releen sus disparos al correr (no se guardan en la config).
      ...(signalDriven ? { userId } : {}),
      capitalUsdt: pick('capitalUsdt', 1, 1e9),
      spreadPct: pick('spreadPct', 0, 100),
      feePct: pick('feePct', 0, 5),
      volPremiumPct: pick('volPremiumPct', -90, 500),
    };
  }

  async function loadCandles(underlying, from, to) {
    const candles = await getCandles(`${underlying}USDT`, '1h', { datasource: 'binance', startTime: from, endTime: to, limit: 1000 });
    return (candles || []).filter((c) => Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.time - b.time);
  }

  /** Corre un backtest ya normalizado y devuelve el resultado (sin persistir). */
  async function runBacktest(config) {
    const template = templates.getTemplate(config.template);
    if (template.signalDriven && !SIGNAL_SOURCES.includes(config.source)) {
      throw new ValidationError('Los bots por alertas no se backtestean con precios grabados');
    }
    let steps;
    let candles = [];
    const extra = {};
    if (config.source === 'recorded') {
      const snapshots = await snapshotsRepo.listRange(config.underlying, config.from, config.to);
      if (!snapshots.length) throw new ValidationError(`No hay snapshots grabados de ${config.underlying} en ese rango`);
      steps = recordedSteps({ underlying: config.underlying, snapshots });
      extra.snapshots = steps.length;
    } else if (config.source === 'dvol') {
      // Los bots con banda ATR necesitan historia previa para el ATR de las primeras aperturas.
      const lookback = config.params.takeProfitMode === 'atr_band' ? REALIZED_WINDOW_HOURS * HOUR_MS : 0;
      candles = await loadCandles(config.underlying, config.from - lookback, config.to);
      const inRange = candles.filter((c) => c.time >= config.from);
      const series = await fetchDvol({ currency: config.underlying, from: config.from - DAY_MS, to: config.to, fetchImpl });
      if (!series.length) throw new ValidationError('Deribit no devolvió DVOL para ese rango');
      steps = syntheticSteps({ underlying: config.underlying, candles: inRange, ivAt: forwardFill(series), spreadPct: config.spreadPct });
    } else {
      candles = await loadCandles(config.underlying, config.from - REALIZED_WINDOW_HOURS * HOUR_MS, config.to);
      const vols = realizedVolSeries(candles);
      const premium = 1 + config.volPremiumPct / 100;
      const byTime = new Map(candles.map((c, i) => [c.time + HOUR_MS, vols[i] == null ? null : Math.max(0.05, vols[i] * premium)]));
      const inRange = candles.filter((c) => c.time >= config.from);
      steps = syntheticSteps({ underlying: config.underlying, candles: inRange, ivAt: (t) => byTime.get(t), spreadPct: config.spreadPct });
    }
    let signals = [];
    if (template.signalDriven) {
      signals = await alertsRepo.listAlertSignals({
        userId: config.userId, alertIds: config.params.alertIds, underlying: config.underlying, from: config.from, to: config.to,
      });
    }
    const result = simulate({
      template,
      params: config.params,
      steps,
      capitalUsdt: config.capitalUsdt,
      feePct: config.feePct,
      signals,
      // Velas de 1h ya cargadas: base de la banda ATR (normalizeConfig rechaza otras temporalidades).
      candles,
    });
    return { ...result, sourceNote: sourceNote(config, extra) };
  }

  async function processNext() {
    if (processing) return;
    const job = queue.shift();
    if (!job) return;
    processing = true;
    idle = (async () => {
      try {
        await repo.markRunning(job.id);
        const result = await runBacktest(job.config);
        await repo.finish(job.id, { status: 'done', result });
        log.info('options_backtest_done', { id: job.id, cycles: result.metrics.cycles });
      } catch (err) {
        log.warn('options_backtest_failed', { id: job.id, error: err.message });
        await repo.finish(job.id, { status: 'failed', error: err.message }).catch(() => null);
      } finally {
        processing = false;
      }
      await processNext();
    })();
  }

  async function enqueue(userId, input) {
    const config = await normalizeConfig(userId, input);
    if ((await repo.countPending(userId)) >= MAX_PENDING_PER_USER) {
      throw new AppError(`Máximo ${MAX_PENDING_PER_USER} backtests en cola por usuario`, { status: 429, code: 'TOO_MANY_BACKTESTS' });
    }
    const row = await repo.create({ userId, strategyId: config.strategyId, config });
    queue.push({ id: row.id, config });
    processNext();
    return row;
  }

  async function get(userId, id) {
    const row = await repo.get(userId, id);
    if (!row) throw new NotFoundError('Backtest no encontrado');
    return row;
  }

  return {
    normalizeConfig,
    runBacktest,
    enqueue,
    list: (userId) => repo.list(userId),
    get,
    /** Espera a que la cola quede vacía (tests). */
    async drain() {
      while (processing || queue.length) await idle;
    },
    async start() {
      const n = await repo.failStale('Interrumpido por reinicio del servidor');
      if (n) log.warn('options_backtests_stale_failed', { count: n });
    },
    stop() {
      queue.length = 0;
    },
  };
}

module.exports = createOptionsBacktestService();
module.exports.createOptionsBacktestService = createOptionsBacktestService;
module.exports.fetchDvol = fetchDvol;
module.exports.realizedVolSeries = realizedVolSeries;
module.exports.simulate = simulate;
module.exports.SOURCES = SOURCES;
