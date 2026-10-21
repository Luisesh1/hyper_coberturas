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
const { ValidationError } = require('../../errors/app-error');

const DAY_MS = 86_400_000;
const LIVE_TTL_MS = 10_000;
const GRID_PCT = 0.3; // rejilla de +-30 % sobre el precio de referencia
const PROBE_CHUNK = 6; // strikes sondeados a la vez
const CANDLE_CACHE_MAX = 300; // entradas maximas (FIFO)
const MAX_RANGE_DAYS = 400; // rango maximo aceptado por getCandles
const YEAR_DAYS = 365;
const EXPIRED_WINDOW_DAYS = 366; // vencidos aceptados por /strikes (los que ofrece listExpiries)
const JOBS_MAX = 200; // trabajos de strikes conservados (se expulsan los terminados mas viejos)

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

// Limites [inicio, fin) del cubo al que pertenece una vela, segun la regla de agregacion.
function bucketBounds(time, rule) {
  if (rule.aggregateMs) {
    const start = Math.floor(time / rule.aggregateMs) * rule.aggregateMs;
    return [start, start + rule.aggregateMs];
  }
  const day = dayFloor(time);
  if (rule.calendar === 'week') {
    const start = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
    return [start, start + 7 * DAY_MS];
  }
  if (rule.calendar === 'month') {
    const d = new Date(time);
    return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
  }
  return [time, time + 1];
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

  const liveCache = new Map(); // underlying -> { promise, expiresAt }

  // Vigentes del subyacente, cacheados 10 s y con llamadas simultaneas compartidas.
  function liveInstruments(underlying) {
    const hit = liveCache.get(underlying);
    if (hit && hit.expiresAt > now()) return hit.promise;
    const u = requireUnderlying(underlying);
    const promise = client
      .getInstruments({ currency: u.currency, expired: false })
      .then((list) =>
        list.map((i) => parseInstrumentName(i.instrument_name)).filter((p) => p && p.underlying === underlying),
      );
    liveCache.set(underlying, { promise, expiresAt: now() + LIVE_TTL_MS });
    promise.catch(() => {
      if (liveCache.get(underlying)?.promise === promise) liveCache.delete(underlying);
    });
    return promise;
  }

  // Una sola serie diaria de Binance para todo el anio rellena spotCache.
  async function prefetchSpots(underlying) {
    const t = now();
    try {
      const candles = await marketData.getCandles(requireUnderlying(underlying).binanceSymbol, '1d', {
        datasource: 'binance',
        startTime: dayFloor(t) - (YEAR_DAYS + 10) * DAY_MS,
        endTime: t,
        limit: YEAR_DAYS + 40,
      });
      for (const c of candles || []) {
        if (c.close > 0) spotCache.set(`${underlying}|${dayFloor(c.time)}`, c.close);
      }
    } catch {
      // sin la serie, spotAt consulta dia por dia
    }
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

  const listInflight = new Map();

  function listExpiries(underlying) {
    requireUnderlying(underlying);
    const running = listInflight.get(underlying);
    if (running) return running;
    const p = computeExpiries(underlying).finally(() => listInflight.delete(underlying));
    listInflight.set(underlying, p);
    return p;
  }

  async function computeExpiries(underlying) {
    const t = now();
    await prefetchSpots(underlying);
    const liveMs = [...new Set((await liveInstruments(underlying)).map((p) => p.expiryMs))].sort((a, b) => a - b);
    const live = liveMs.map((ms) => ({ code: formatExpiryCode(ms), expiryMs: ms, live: true }));
    const liveSet = new Set(liveMs);

    const fridays = fridaysBetween(t - 365 * DAY_MS, t).filter((ms) => ms < t && !liveSet.has(ms));
    const dead = [];
    for (let i = 0; i < fridays.length; i += PROBE_CHUNK) {
      const chunk = fridays.slice(i, i + PROBE_CHUNK);
      // Un viernes cuyo sondeo falla se omite (sin cachear veredicto); el resto sigue.
      const flags = await Promise.all(chunk.map((ms) => fridayExists(underlying, ms).catch(() => false)));
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
    job.live = true;
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

  // Mantiene el mapa acotado: expulsa los trabajos terminados mas antiguos.
  function pruneJobs() {
    for (const [k, j] of jobs) {
      if (jobs.size <= JOBS_MAX) break;
      if (j.status !== 'running') jobs.delete(k);
    }
  }

  // Lanza el trabajo la primera vez; luego devuelve su estado. Un trabajo en error solo se
  // relanza con { retry: true } (el sondeo periodico de la UI no debe borrar el error).
  function getStrikesJob(underlying, expiryCode, { retry = false } = {}) {
    requireUnderlying(underlying);
    let expiryMs;
    try {
      expiryMs = parseExpiryCode(expiryCode);
      if (!Number.isFinite(expiryMs) || formatExpiryCode(expiryMs) !== expiryCode) throw new Error('fecha');
    } catch {
      throw new ValidationError(`Vencimiento invalido: ${expiryCode}`);
    }
    // Vencidos: solo viernes del ultimo anio (el mismo conjunto que ofrece listExpiries).
    if (expiryMs < now()) {
      const friday = new Date(expiryMs).getUTCDay() === 5;
      if (!friday || expiryMs < now() - EXPIRED_WINDOW_DAYS * DAY_MS) {
        throw new ValidationError(`Vencimiento fuera de rango: ${expiryCode}`);
      }
    }
    const key = `${underlying}|${expiryCode}`;
    let job = jobs.get(key);
    if (job) {
      const t = now();
      const stale =
        job.status === 'done' &&
        ((expiryMs >= t && t - job.finishedAt > LIVE_TTL_MS) || (job.live && expiryMs < t));
      if (!stale && !(job.status === 'error' && retry)) return snapshot(job);
    }

    job = { status: 'running', probed: 0, total: 0, spotRef: null, strikes: [], error: null, finishedAt: 0, live: false };
    jobs.delete(key); // reinsertar al final: el orden del Map es el de antiguedad
    jobs.set(key, job);
    pruneJobs();
    const run = expiryMs < now() ? runExpired : runLive;
    run(job, underlying, expiryMs).then(
      () => {
        job.status = 'done';
        job.finishedAt = now();
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
    // Limita el rango para que el cache no crezca sin control con zooms extremos.
    startMs = Math.max(startMs, endMs - MAX_RANGE_DAYS * DAY_MS);
    // La primera vela agregada empieza antes de startMs: se pide desde el inicio de su cubo.
    const fetchStart = bucketBounds(dayFloor(startMs), rule)[0];
    const startDay = dayFloor(fetchStart);
    const endDay = dayFloor(endMs);
    const key = `${instrument}|${rule.resolution}|${timeframe}|${startDay}|${endDay}`;

    // El cache guarda el rango de dias completo; la ventana exacta se recorta al leer.
    const inWindow = (list) => list.filter((c) => bucketBounds(c.time, rule)[1] > startMs && c.time <= endMs);
    const hit = candleCache.get(key);
    if (hit && hit.expiresAt > now()) return inWindow(hit.value);
    if (hit) candleCache.delete(key);

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
    const value = toUsdCandles(candles, { inverse: parsed.inverse, underlyingCloseByTime });

    const permanent = parsed.expiryMs < now();
    while (candleCache.size >= CANDLE_CACHE_MAX) candleCache.delete(candleCache.keys().next().value);
    candleCache.set(key, { value, expiresAt: permanent ? Infinity : now() + LIVE_TTL_MS });
    return inWindow(value);
  }

  return { listExpiries, getStrikesJob, getCandles };
}

const deribitOptionsService = createDeribitOptionsService({
  client: deribitClient,
  marketData: require('../market-data.service'),
});

module.exports = { createDeribitOptionsService, deribitOptionsService };
