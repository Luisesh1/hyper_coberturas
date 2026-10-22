/**
 * alert-backtest.service.js
 *
 * Backtest histórico de una alerta: dónde habría disparado el motor en vivo.
 *
 * Solo lectura: no envía Telegram, no escribe `alert_events`, no toca
 * `lastTriggeredAt` y no emite señales. La puntuación es la misma del motor
 * (`scoreAlert`); aquí solo se reproduce, en cada cierre de la temporalidad
 * base, la ventana de velas que vería el scheduler y su regla de cooldown.
 */

const { ValidationError } = require('../../errors/app-error');
const marketData = require('../market-data.service');
const alertsService = require('./alerts.service');

const {
  scoreAlert,
  lowestTimeframe,
  distinctTimeframes,
  candleCloseTimeMs,
  POST_CLOSE_BUFFER_MS,
  CANDLE_FETCH_LIMIT,
} = alertsService;

const TF_MS = marketData.TIMEFRAME_TO_MS;

// En vivo `lastTriggeredAt` es el instante de envío, que cae después de la
// evaluación (traer velas + Telegram). Se fija en evaluación + 1 s.
const SEND_DELAY_MS = 1000;
const MAX_EVALS_PER_REQUEST = 2000;
const MAX_COOLDOWN_LOOKBACK_FACTOR = 32;

// Calentamiento del cooldown: 32·cd, pero nunca más de MAX_EVALS_PER_REQUEST
// boundaries extra (cd = 1 día en 1m serían 46 080 evaluaciones).
function cooldownLookbackMs(cooldownMs, baseMs) {
  return Math.min(MAX_COOLDOWN_LOOKBACK_FACTOR * cooldownMs, MAX_EVALS_PER_REQUEST * baseMs);
}

// ------------------------------------------------------------------
// Ventana en el instante T
// ------------------------------------------------------------------

// Primer índice con pred(i) === true; pred monótona (false… true…).
function firstIndexWhere(length, pred) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Lo que recibe el evaluador en vivo en T: getCandles(limit 250) es la
// ventana de tiempo [T − 250·tf, T] y filterClosedCandles quita la vela en curso.
function windowAt(candles, tf, evalTimeMs) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const tfMs = TF_MS[tf];
  const startMs = evalTimeMs - CANDLE_FETCH_LIMIT * tfMs;
  const from = firstIndexWhere(candles.length, (i) => Number(candles[i].time) >= startMs);
  const to = firstIndexWhere(candles.length, (i) => {
    const close = candleCloseTimeMs(candles[i], tf);
    return close == null || close > evalTimeMs;
  });
  return from < to ? candles.slice(from, to) : [];
}

// ------------------------------------------------------------------
// Simulación
// ------------------------------------------------------------------

function ruleSummary(result) {
  const rule = result.rule || {};
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [rule];
  const first = conds[0] || {};
  return {
    indicatorType: first.indicatorType ?? null,
    timeframe: first.timeframe ?? null,
    conditions: conds.map((c) => ({ indicatorType: c?.indicatorType ?? null, timeframe: c?.timeframe ?? null })),
    weight: rule.weight,
    matched: Boolean(result.matched),
    reason: result.reason ?? null,
  };
}

function simulate({ alert, candlesByTf, fromMs, toMs }) {
  const rules = Array.isArray(alert?.rules) ? alert.rules : [];
  const baseTimeframe = lowestTimeframe(rules);
  const empty = { baseTimeframe, events: [], insufficient: 0, cooldownApprox: false };
  const baseMs = TF_MS[baseTimeframe];
  if (!baseMs || !(toMs > fromMs)) return empty;

  const tfs = distinctTimeframes(rules);
  const threshold = Number(alert.thresholdPercent);
  const cooldownMs = Math.max(0, Number(alert.cooldownSeconds || 0) * 1000);

  // Cache por boundary: { insufficient } | { score, ruleResults, wouldTrigger, closeMs }.
  // Como en vivo, se evalúa lo que esté cerrado en T = boundary + 3 s, aunque
  // ninguna vela base cierre justo en el boundary (Yahoo, 1w en jueves…).
  const cache = new Map();
  function evaluateAt(boundary) {
    let ev = cache.get(boundary);
    if (ev) return ev;
    const T = boundary + POST_CLOSE_BUFFER_MS;
    const windows = {};
    let insufficient = false;
    for (const tf of tfs) {
      const all = candlesByTf?.[tf] || [];
      const win = windowAt(all, tf, T);
      // Sin velas, o los datos no cubren el inicio de la ventana (historia
      // recortada por el proveedor): en vivo habría visto otras velas.
      if (win.length === 0 || Number(all[0].time) >= T - CANDLE_FETCH_LIMIT * TF_MS[tf] + TF_MS[tf]) {
        insufficient = true;
        break;
      }
      windows[tf] = win;
    }
    if (insufficient) {
      ev = { insufficient: true, wouldTrigger: false };
    } else {
      const { ruleResults, score } = scoreAlert(rules, windows);
      const base = windows[baseTimeframe];
      // Lo que el motor registra como candleCloseTime.
      const closeMs = candleCloseTimeMs(base[base.length - 1], baseTimeframe);
      ev = { insufficient: false, score, ruleResults, wouldTrigger: score >= threshold, closeMs };
    }
    cache.set(boundary, ev);
    return ev;
  }

  // Boundaries del scheduler: múltiplos de tf alineados al epoch.
  const lastBefore = (ms) => Math.floor(ms / baseMs) * baseMs;
  const firstBoundary = lastBefore(fromMs) + baseMs; // primer boundary > fromMs
  const lastBoundary = lastBefore(toMs);

  // Punto de reinicio: último boundary p ≤ fromMs sin ningún wouldTrigger en
  // (p − cd, p]. En los boundaries > p ningún envío anterior pesa: el último
  // posible cae en ≤ p − cd, y cd + tf ≥ cd + SEND_DELAY_MS.
  // Recorrer hacia atrás de forma perezosa equivale a duplicar W hasta el tope.
  let simStart = firstBoundary; // primer boundary que se simula
  let cooldownApprox = false;
  if (cooldownMs > 0) {
    // Anclado al boundary (no a fromMs) para que el tope cubra siempre el
    // mismo número de boundaries; run pide velas desde ese mismo ancla.
    const lowest = lastBefore(fromMs) - cooldownLookbackMs(cooldownMs, baseMs);
    let candidate = null;
    let found = null;
    for (let b = lastBefore(fromMs); b >= lowest; b -= baseMs) {
      if (evaluateAt(b).wouldTrigger) {
        candidate = null;
        continue;
      }
      if (candidate == null) candidate = b;
      if (b - baseMs <= candidate - cooldownMs) {
        found = candidate;
        break;
      }
    }
    if (found != null) {
      simStart = found + baseMs;
    } else {
      cooldownApprox = true;
      simStart = lowest;
    }
  }

  const events = [];
  let insufficientCount = 0;
  let lastSentAt = null;
  for (let b = simStart; b <= lastBoundary; b += baseMs) {
    const ev = evaluateAt(b);
    const inRange = b > fromMs;
    if (ev.insufficient) {
      if (inRange) insufficientCount += 1;
      continue;
    }
    if (!ev.wouldTrigger) continue;
    const evalAt = b + POST_CLOSE_BUFFER_MS;
    const suppressed = lastSentAt != null && cooldownMs - (evalAt - lastSentAt) > 0;
    if (!suppressed) lastSentAt = evalAt + SEND_DELAY_MS;
    if (inRange) {
      events.push({
        time: ev.closeMs,
        evalTime: b,
        score: ev.score,
        threshold,
        suppressed,
        rules: ev.ruleResults.map(ruleSummary),
      });
    }
  }

  return { baseTimeframe, events, insufficient: insufficientCount, cooldownApprox };
}

// ------------------------------------------------------------------
// Orquestación
// ------------------------------------------------------------------

function createAlertBacktest({ getAlert, getCandles, now = Date.now }) {
  async function run(userId, alertId, { asset, datasource, startTime, endTime } = {}) {
    const alert = await getAlert(userId, alertId);
    const rules = Array.isArray(alert.rules) ? alert.rules : [];
    const baseTimeframe = lowestTimeframe(rules);
    const baseMs = TF_MS[baseTimeframe];
    if (!baseMs) throw new ValidationError('la alerta no tiene reglas evaluables');
    if (!asset) throw new ValidationError('asset requerido');

    const from = Number(startTime);
    // Ningún boundary que el scheduler aún no habría evaluado (b + 3 s ≤ now).
    const to = Math.min(Number(endTime), now() - POST_CLOSE_BUFFER_MS);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new ValidationError('rango inválido: startTime debe ser menor que endTime');
    }
    if ((to - from) / baseMs > MAX_EVALS_PER_REQUEST) {
      throw new ValidationError(`rango demasiado grande: máximo ${MAX_EVALS_PER_REQUEST} velas de ${baseTimeframe}`);
    }

    const ds = datasource || alert.datasource;
    const cooldownMs = Math.max(0, Number(alert.cooldownSeconds || 0) * 1000);
    const lookbackMs = cooldownLookbackMs(cooldownMs, baseMs);
    const candlesByTf = {};
    await Promise.all(distinctTimeframes(rules).map(async (tf) => {
      candlesByTf[tf] = await getCandles(asset, tf, {
        datasource: ds,
        startTime: Math.floor(from / baseMs) * baseMs - lookbackMs - CANDLE_FETCH_LIMIT * TF_MS[tf],
        endTime: to,
      });
    }));

    const result = simulate({ alert, candlesByTf, fromMs: from, toMs: to });
    return {
      alertId: alert.id,
      alertUpdatedAt: alert.updatedAt,
      asset,
      datasource: ds,
      alertDatasource: alert.datasource,
      baseTimeframe: result.baseTimeframe,
      from,
      to,
      events: result.events,
      insufficient: result.insufficient,
      cooldownApprox: result.cooldownApprox,
    };
  }
  return { run };
}

const defaultInstance = createAlertBacktest({
  getAlert: alertsService.getAlert,
  getCandles: marketData.getCandles,
});

module.exports = {
  MAX_COOLDOWN_LOOKBACK_FACTOR,
  MAX_EVALS_PER_REQUEST,
  SEND_DELAY_MS,
  createAlertBacktest,
  run: defaultInstance.run,
  simulate,
  windowAt,
};
