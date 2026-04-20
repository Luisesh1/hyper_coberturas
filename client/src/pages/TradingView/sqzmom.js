// Squeeze Momentum Indicator (LazyBear)
// Port directo del Pine v2 original:
//   study("SQZMOM_LB", overlay=false)
//   length=20, mult=2.0, lengthKC=20, multKC=1.5, useTrueRange=true
//   BB = SMA±mult·stdev,  KC = SMA±multKC·SMA(range)
//   val = linreg(source - avg(avg(highest, lowest), sma(close)), lengthKC, 0)
//   Colores:
//     val > 0: val > val[-1] ? lime : green
//     val ≤ 0: val < val[-1] ? red  : maroon
//     squeeze: noSqz ? blue : sqzOn ? black : gray
//
// Las candles de entrada son el shape de `marketDataService.getCandles`:
//   { time, open, high, low, close, volume }
// `time` en ms epoch. El indicador ignora huecos; solo requiere que las
// candles vengan ordenadas ascendentemente.

function sma(values, length, i) {
  if (i + 1 < length) return NaN;
  let sum = 0;
  for (let k = i - length + 1; k <= i; k += 1) sum += values[k];
  return sum / length;
}

function stdev(values, length, i) {
  if (i + 1 < length) return NaN;
  const mean = sma(values, length, i);
  let acc = 0;
  for (let k = i - length + 1; k <= i; k += 1) {
    const d = values[k] - mean;
    acc += d * d;
  }
  // Pine usa stdev poblacional (N), no muestral (N-1).
  return Math.sqrt(acc / length);
}

function highestIn(values, length, i) {
  if (i + 1 < length) return NaN;
  let m = -Infinity;
  for (let k = i - length + 1; k <= i; k += 1) if (values[k] > m) m = values[k];
  return m;
}

function lowestIn(values, length, i) {
  if (i + 1 < length) return NaN;
  let m = Infinity;
  for (let k = i - length + 1; k <= i; k += 1) if (values[k] < m) m = values[k];
  return m;
}

// True Range: max(H-L, |H-C[-1]|, |L-C[-1]|). En la primera vela no hay
// cierre previo → usamos H-L.
function trueRange(candles, i) {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const prevClose = candles[i - 1].close;
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prevClose),
    Math.abs(c.low - prevClose)
  );
}

// Pine `linreg(source, length, offset)` = intercept + slope · (length-1-offset).
// Con offset=0 equivale a la proyección al bar actual de la regresión por
// mínimos cuadrados sobre las últimas `length` muestras.
function linreg(values, length, i, offset = 0) {
  if (i + 1 < length) return NaN;
  // x = 0..length-1, pero Pine usa x creciente hacia el pasado: el último
  // valor (i) corresponde a x=length-1. Para que el resultado coincida con
  // Pine, calculamos pendiente e intercepto con esa orientación.
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let k = 0; k < length; k += 1) {
    const y = values[i - k];       // k=0 → actual; k=length-1 → más viejo
    const x = length - 1 - k;      // x=length-1 actual, x=0 más viejo
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const n = length;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return NaN;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return intercept + slope * (length - 1 - offset);
}

export const SQZMOM_DEFAULTS = Object.freeze({
  length: 20,
  mult: 2.0,
  lengthKC: 20,
  multKC: 1.5,
  useTrueRange: true,
});

export function computeSqueezeMomentum(candles, params = {}) {
  const cfg = { ...SQZMOM_DEFAULTS, ...params };
  const n = candles.length;
  const out = new Array(n);
  if (n === 0) return out;

  const close = new Array(n);
  const high = new Array(n);
  const low = new Array(n);
  for (let i = 0; i < n; i += 1) {
    close[i] = candles[i].close;
    high[i] = candles[i].high;
    low[i] = candles[i].low;
  }

  // Pre-cálculo del range (TR o H-L).
  const range = new Array(n);
  for (let i = 0; i < n; i += 1) {
    range[i] = cfg.useTrueRange ? trueRange(candles, i) : (high[i] - low[i]);
  }

  // Pre-cálculo de la "source - avg(...)" que alimenta linreg.
  // Requiere highest(high,lengthKC), lowest(low,lengthKC), sma(close,lengthKC).
  const delta = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const hh = highestIn(high, cfg.lengthKC, i);
    const ll = lowestIn(low, cfg.lengthKC, i);
    const smaClose = sma(close, cfg.lengthKC, i);
    if (Number.isNaN(hh) || Number.isNaN(ll) || Number.isNaN(smaClose)) {
      delta[i] = NaN;
      continue;
    }
    const avg1 = (hh + ll) / 2;
    const avg12 = (avg1 + smaClose) / 2;
    delta[i] = close[i] - avg12;
  }

  for (let i = 0; i < n; i += 1) {
    const basis = sma(close, cfg.length, i);
    const stdDev = stdev(close, cfg.length, i);
    const ma = sma(close, cfg.lengthKC, i);
    const rangema = sma(range, cfg.lengthKC, i);

    // El Pine original usa `multKC * stdev(...)` para el ancho de la BB
    // (en vez de `mult`). Es un "bug" famoso del indicador de LazyBear
    // que la comunidad replicó tal cual; lo conservamos para que los
    // valores coincidan con la versión que miles de traders ya usan.
    const dev = cfg.multKC * stdDev;
    const upperBB = basis + dev;
    const lowerBB = basis - dev;

    const upperKC = ma + rangema * cfg.multKC;
    const lowerKC = ma - rangema * cfg.multKC;

    const sqzOn = lowerBB > lowerKC && upperBB < upperKC;
    const sqzOff = lowerBB < lowerKC && upperBB > upperKC;
    const noSqz = !sqzOn && !sqzOff;

    const val = linreg(delta, cfg.lengthKC, i, 0);

    out[i] = {
      time: Math.floor(candles[i].time / 1000), // lightweight-charts usa segundos epoch
      value: Number.isFinite(val) ? val : undefined,
      sqzOn,
      sqzOff,
      noSqz,
      // El histograma cambia de color según dirección y pendiente del val.
      color: undefined, // lo completamos debajo con el val[-1].
    };
  }

  // Segunda pasada para calcular colores con val[-1].
  for (let i = 0; i < n; i += 1) {
    const cur = out[i];
    if (cur == null || cur.value == null) continue;
    const prev = i > 0 ? out[i - 1]?.value : null;
    const prevIsFinite = Number.isFinite(prev);
    if (cur.value > 0) {
      cur.color = prevIsFinite && cur.value > prev ? '#00e676' /* lime */ : '#2e7d32' /* green */;
    } else {
      cur.color = prevIsFinite && cur.value < prev ? '#ef5350' /* red */ : '#8e1b1b' /* maroon */;
    }
  }

  return out;
}

// Dots del estado del squeeze (la línea cross en 0 del Pine original).
// Devuelve una serie plana con value=0 y color según sqzOn/sqzOff/noSqz.
export function buildSqueezeDots(sqzmomSeries) {
  return sqzmomSeries.map((p) => {
    if (!p) return null;
    let color;
    if (p.noSqz) color = '#2962ff';           // blue: no hay squeeze
    else if (p.sqzOn) color = '#000000';      // black: squeeze activo
    else color = '#9e9e9e';                   // gray: squeeze se soltó (sqzOff)
    return { time: p.time, value: 0, color };
  }).filter(Boolean);
}
