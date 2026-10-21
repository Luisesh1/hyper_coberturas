// Servicio de opciones de Deribit: vencimientos, sondeo de strikes y velas en USD.
const {
  UNDERLYINGS,
  formatExpiryCode,
  parseExpiryCode,
  buildInstrumentName,
  parseInstrumentName,
  fridaysBetween,
} = require('./deribit-instruments');
const { resolutionFor, chartDataToCandles, aggregateCandles, toUsdCandles } = require('./option-series');
const { deribitClient } = require('./deribit.client');

const DAY_MS = 86_400_000;
const LIVE_TTL_MS = 10_000;
const GRID_PCT = 0.3; // rejilla de +-30 % sobre el precio de referencia
const PROBE_CHUNK = 6; // strikes sondeados a la vez

const dayFloor = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const decimalsOf = (step) => (String(step).split('.')[1] || '').length;

function requireUnderlying(underlying) {
  const u = UNDERLYINGS[underlying];
  if (!u) throw new Error(`Subyacente sin Deribit: ${underlying}`);
  return u;
}

// Multiplos de `step` dentro de +-30 % de spotRef, sin ruido de coma flotante.
function strikeGrid(spotRef, step) {
  const dec = decimalsOf(step);
  const from = Math.ceil((spotRef * (1 - GRID_PCT)) / step - 1e-9);
  const to = Math.floor((spotRef * (1 + GRID_PCT)) / step + 1e-9);
  const out = [];
  for (let k = from; k <= to; k++) {
    if (k > 0) out.push(Number((k * step).toFixed(dec)));
  }
  return out;
}

function atmStrike(spotRef, step) {
  return Number((Math.round(spotRef / step) * step).toFixed(decimalsOf(step)));
}

function createDeribitOptionsService({ client = deribitClient, marketData, now = Date.now } = {}) {
  const spotCache = new Map(); // underlying|dia -> precio
  const verdicts = new Map(); // underlying|codigo -> boolean (permanente)
  const jobs = new Map(); // underlying|codigo -> job
  const candleCache = new Map(); // clave -> { value, expiresAt }

  // Cierre diario de Binance del dia indicado (ultima vela con time <= dia).
  async function spotAt(underlying, targetMs) {
    const key = `${underlying}|${dayFloor(targetMs)}`;
    if (spotCache.has(key)) return spotCache.get(key);
    const day = dayFloor(targetMs);
    const candles = await marketData.getCandles(requireUnderlying(underlying).binanceSymbol, '1d', {
      datasource: 'binance',
      startTime: day - 2 * DAY_MS,
      endTime: day + DAY_MS,
      limit: 5,
    });
    const usable = (candles || []).filter((c) => c.time <= day + DAY_MS - 1 && c.close > 0);
    const best = usable.sort((a, b) => b.time - a.time)[0];
    if (!best) throw new Error(`Sin precio de ${underlying} para ${new Date(day).toISOString().slice(0, 10)}`);
    spotCache.set(key, best.close);
    return best.close;
  }

  async function liveInstruments(underlying) {
    const u = requireUnderlying(underlying);
    const list = await client.getInstruments({ currency: u.currency, expired: false });
    return list
      .map((i) => parseInstrumentName(i.instrument_name))
      .filter((p) => p && p.underlying === underlying);
  }

  async function fridayExists(underlying, expiryMs) {
    const key = `${underlying}|${formatExpiryCode(expiryMs)}`;
    if (verdicts.has(key)) return verdicts.get(key);
    const u = requireUnderlying(underlying);
    const spot = await spotAt(underlying, expiryMs - 7 * DAY_MS);
    let exists = false;
    for (const step of u.strikeSteps.slice(0, 2)) {
      const name = buildInstrumentName({ underlying, expiryMs, strike: atmStrike(spot, step), type: 'C' });
      if (await client.getInstrument(name)) {
        exists = true;
        break;
      }
    }
    verdicts.set(key, exists);
    return exists;
  }

  async function listExpiries(underlying) {
    requireUnderlying(underlying);
    const t = now();
    const liveMs = [...new Set((await liveInstruments(underlying)).map((p) => p.expiryMs))].sort((a, b) => a - b);
    const live = liveMs.map((ms) => ({ code: formatExpiryCode(ms), expiryMs: ms, live: true }));
    const liveSet = new Set(liveMs);

    const fridays = fridaysBetween(t - 365 * DAY_MS, t).filter((ms) => ms < t && !liveSet.has(ms));
    const dead = [];
    for (let i = 0; i < fridays.length; i += PROBE_CHUNK) {
      const chunk = fridays.slice(i, i + PROBE_CHUNK);
      const flags = await Promise.all(chunk.map((ms) => fridayExists(underlying, ms)));
      chunk.forEach((ms, k) => {
        if (flags[k]) dead.push({ code: formatExpiryCode(ms), expiryMs: ms, live: false });
      });
    }
    dead.sort((a, b) => b.expiryMs - a.expiryMs);
    return [...live, ...dead];
  }

  const snapshot = (job) => ({
    status: job.status,
    probed: job.probed,
    total: job.total,
    spotRef: job.spotRef,
    strikes: job.strikes.slice(),
    error: job.error,
  });

  const withDistance = (strike, spotRef, call, put) => ({
    strike,
    call,
    put,
    distancePct: spotRef ? (strike / spotRef - 1) * 100 : null,
  });

  async function runLive(job, underlying, expiryMs) {
    const parsed = (await liveInstruments(underlying)).filter((p) => p.expiryMs === expiryMs);
    try {
      job.spotRef = await spotAt(underlying, now());
    } catch {
      job.spotRef = null; // sin precio solo se pierde la distancia
    }
    const byStrike = new Map();
    for (const p of parsed) {
      const row = byStrike.get(p.strike) || { call: null, put: null };
      row[p.type === 'C' ? 'call' : 'put'] = buildInstrumentName({ underlying, expiryMs, strike: p.strike, type: p.type });
      byStrike.set(p.strike, row);
    }
    job.strikes = [...byStrike.keys()]
      .sort((a, b) => a - b)
      .map((s) => withDistance(s, job.spotRef, byStrike.get(s).call, byStrike.get(s).put));
    job.total = job.probed = job.strikes.length;
  }

  async function runExpired(job, underlying, expiryMs) {
    const u = requireUnderlying(underlying);
    job.spotRef = await spotAt(underlying, expiryMs - 7 * DAY_MS);
    const grid = strikeGrid(job.spotRef, u.strikeSteps[0]);
    job.total = grid.length;
    for (let i = 0; i < grid.length; i += PROBE_CHUNK) {
      const chunk = grid.slice(i, i + PROBE_CHUNK);
      const results = await Promise.allSettled(
        chunk.map(async (strike) => {
          const [c, p] = await Promise.all(
            ['C', 'P'].map((type) => {
              const name = buildInstrumentName({ underlying, expiryMs, strike, type });
              return client.getInstrument(name).then((r) => (r ? name : null));
            }),
          );
          return { strike, call: c, put: p };
        }),
      );
      let failure = null;
      for (const r of results) {
        if (r.status === 'rejected') {
          failure = failure || r.reason;
          continue;
        }
        job.probed++;
        const { strike, call, put } = r.value;
        if (call || put) job.strikes.push(withDistance(strike, job.spotRef, call, put));
      }
      if (failure) throw failure;
    }
  }

  // Lanza el trabajo la primera vez; luego devuelve su estado. Un trabajo en error solo se
  // relanza con { retry: true } (el sondeo periodico de la UI no debe borrar el error).
  function getStrikesJob(underlying, expiryCode, { retry = false } = {}) {
    requireUnderlying(underlying);
    const key = `${underlying}|${expiryCode}`;
    let job = jobs.get(key);
    if (job && !(job.status === 'error' && retry)) return snapshot(job);

    const expiryMs = parseExpiryCode(expiryCode);
    job = { status: 'running', probed: 0, total: 0, spotRef: null, strikes: [], error: null };
    jobs.set(key, job);
    const run = expiryMs < now() ? runExpired : runLive;
    run(job, underlying, expiryMs).then(
      () => {
        job.status = 'done';
      },
      (err) => {
        job.status = 'error';
        job.error = err?.message || String(err);
      },
    );
    return snapshot(job);
  }

  async function getCandles({ instrument, timeframe, startMs, endMs }) {
    const parsed = parseInstrumentName(instrument);
    if (!parsed) throw new Error(`Instrumento invalido: ${instrument}`);
    const rule = resolutionFor(timeframe);
    const startDay = dayFloor(startMs);
    const endDay = dayFloor(endMs);
    const key = `${instrument}|${rule.resolution}|${timeframe}|${startDay}|${endDay}`;

    const hit = candleCache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;

    const range = { resolution: rule.resolution, startMs: startDay, endMs: endDay + DAY_MS - 1 };
    const [optData, perpData] = await Promise.all([
      client.getChartData({ instrument, ...range }),
      parsed.inverse
        ? client.getChartData({ instrument: UNDERLYINGS[parsed.underlying].perpetual, ...range })
        : null,
    ]);

    const candles = aggregateCandles(chartDataToCandles(optData), timeframe);
    let underlyingCloseByTime = null;
    if (parsed.inverse) {
      // Mismo timeframe y agregacion que la opcion, para que los tiempos coincidan.
      const perp = aggregateCandles(chartDataToCandles(perpData), timeframe);
      underlyingCloseByTime = new Map(perp.map((c) => [c.time, c.close]));
    }
    const value = toUsdCandles(candles, { inverse: parsed.inverse, underlyingCloseByTime }).filter(
      (c) => c.time >= startMs && c.time <= endMs,
    );

    const permanent = parsed.expiryMs < now();
    candleCache.set(key, { value, expiresAt: permanent ? Infinity : now() + LIVE_TTL_MS });
    return value;
  }

  return { listExpiries, getStrikesJob, getCandles };
}

const deribitOptionsService = createDeribitOptionsService({
  client: deribitClient,
  marketData: require('../market-data.service'),
});

module.exports = { createDeribitOptionsService, deribitOptionsService };
