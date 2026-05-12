const DEFAULT_PRECISION = 8;

function round(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(DEFAULT_PRECISION));
}

function toSeries(input, source = 'close') {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === 'number') return Number(item);
    if (item && typeof item === 'object') {
      const value = item[source] ?? item.c ?? item.close;
      return value == null ? null : Number(value);
    }
    return null;
  });
}

function compactWindow(series, end, period) {
  const start = Math.max(0, end - period + 1);
  const window = series.slice(start, end + 1).filter((value) => Number.isFinite(value));
  if (window.length < period) return null;
  return window;
}

function sma(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  const source = params.source || 'close';
  const series = toSeries(input, source);

  return series.map((_value, index) => {
    const window = compactWindow(series, index, period);
    if (!window) return null;
    const sum = window.reduce((acc, current) => acc + current, 0);
    return round(sum / period);
  });
}

function ema(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  const source = params.source || 'close';
  const series = toSeries(input, source);
  const multiplier = 2 / (period + 1);
  let previous = null;

  return series.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    if (index < period - 1) return null;
    if (index === period - 1) {
      const seedWindow = compactWindow(series, index, period);
      if (!seedWindow) return null;
      previous = seedWindow.reduce((acc, current) => acc + current, 0) / period;
      return round(previous);
    }

    previous = ((value - previous) * multiplier) + previous;
    return round(previous);
  });
}

function rsi(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  const source = params.source || 'close';
  const series = toSeries(input, source);
  if (series.length === 0) return [];

  const deltas = series.map((value, index) => {
    if (index === 0 || !Number.isFinite(value) || !Number.isFinite(series[index - 1])) return null;
    return value - series[index - 1];
  });

  const result = Array(series.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  for (let index = 1; index < series.length; index += 1) {
    const delta = deltas[index];
    if (!Number.isFinite(delta)) continue;

    if (index <= period) {
      avgGain += Math.max(delta, 0);
      avgLoss += Math.max(-delta, 0);
      if (index === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result[index] = round(100 - (100 / (1 + rs)));
      }
      continue;
    }

    avgGain = ((avgGain * (period - 1)) + Math.max(delta, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-delta, 0)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[index] = round(100 - (100 / (1 + rs)));
  }

  return result;
}

function macd(input, params = {}) {
  const fastPeriod = Math.max(1, Number(params.fastPeriod) || 12);
  const slowPeriod = Math.max(fastPeriod + 1, Number(params.slowPeriod) || 26);
  const signalPeriod = Math.max(1, Number(params.signalPeriod) || 9);
  const source = params.source || 'close';
  const fast = ema(input, { period: fastPeriod, source });
  const slow = ema(input, { period: slowPeriod, source });
  const macdLine = fast.map((value, index) => (
    Number.isFinite(value) && Number.isFinite(slow[index]) ? round(value - slow[index]) : null
  ));
  const signalLine = ema(macdLine, { period: signalPeriod, source: 'close' });

  return macdLine.map((value, index) => ({
    macd: value,
    signal: signalLine[index],
    histogram: Number.isFinite(value) && Number.isFinite(signalLine[index])
      ? round(value - signalLine[index])
      : null,
  }));
}

function atr(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  if (!Array.isArray(input)) return [];
  const trueRanges = input.map((candle, index) => {
    const high = Number(candle?.high ?? candle?.h);
    const low = Number(candle?.low ?? candle?.l);
    const previousClose = index > 0 ? Number(input[index - 1]?.close ?? input[index - 1]?.c) : null;
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    if (!Number.isFinite(previousClose)) return round(high - low);
    return round(Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    ));
  });

  const result = Array(trueRanges.length).fill(null);
  let previousAtr = null;

  for (let index = 0; index < trueRanges.length; index += 1) {
    const current = trueRanges[index];
    if (!Number.isFinite(current)) continue;
    if (index < period - 1) continue;
    if (index === period - 1) {
      const window = compactWindow(trueRanges, index, period);
      if (!window) continue;
      previousAtr = window.reduce((acc, value) => acc + value, 0) / period;
      result[index] = round(previousAtr);
      continue;
    }
    previousAtr = (((previousAtr * (period - 1)) + current) / period);
    result[index] = round(previousAtr);
  }

  return result;
}

function bollinger(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 20);
  const multiplier = Number(params.multiplier) || 2;
  const source = params.source || 'close';
  const series = toSeries(input, source);
  const middle = sma(series, { period, source: 'close' });

  return series.map((_value, index) => {
    const window = compactWindow(series, index, period);
    if (!window || !Number.isFinite(middle[index])) {
      return { middle: null, upper: null, lower: null, stdDev: null };
    }
    const variance = window.reduce((acc, current) => acc + ((current - middle[index]) ** 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: round(middle[index]),
      upper: round(middle[index] + (stdDev * multiplier)),
      lower: round(middle[index] - (stdDev * multiplier)),
      stdDev: round(stdDev),
    };
  });
}

function last(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  return series[series.length - 1];
}

// ------------------------------------------------------------------
// Indicadores adicionales (usados por el evaluador de alertas)
// ------------------------------------------------------------------

function wma(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  const source = params.source || 'close';
  const series = toSeries(input, source);
  const denom = (period * (period + 1)) / 2;

  return series.map((_value, index) => {
    const window = compactWindow(series, index, period);
    if (!window) return null;
    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += window[i] * (i + 1);
    return round(sum / denom);
  });
}

function highsLowsCloses(input) {
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  for (const candle of (input || [])) {
    highs.push(Number(candle?.high ?? candle?.h));
    lows.push(Number(candle?.low ?? candle?.l));
    closes.push(Number(candle?.close ?? candle?.c));
    volumes.push(Number(candle?.volume ?? candle?.v ?? 0));
  }
  return { highs, lows, closes, volumes };
}

function stoch(input, params = {}) {
  const kLength = Math.max(1, Number(params.kLength) || 14);
  const dLength = Math.max(1, Number(params.dLength) || 3);
  const smooth = Math.max(1, Number(params.smooth) || 3);
  const { highs, lows, closes } = highsLowsCloses(input);
  const n = closes.length;
  const rawK = Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    if (i < kLength - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kLength + 1; j <= i; j += 1) {
      if (Number.isFinite(highs[j]) && highs[j] > hh) hh = highs[j];
      if (Number.isFinite(lows[j]) && lows[j] < ll) ll = lows[j];
    }
    const range = hh - ll;
    if (!Number.isFinite(range) || range === 0) {
      rawK[i] = 50;
    } else {
      rawK[i] = ((closes[i] - ll) / range) * 100;
    }
  }
  const kSmoothed = sma(rawK, { period: smooth, source: 'close' });
  const dLine = sma(kSmoothed, { period: dLength, source: 'close' });
  return { k: kSmoothed, d: dLine };
}

function adx(input, params = {}) {
  const period = Math.max(1, Number(params.period) || 14);
  const { highs, lows, closes } = highsLowsCloses(input);
  const n = closes.length;
  const tr = Array(n).fill(0);
  const plusDM = Array(n).fill(0);
  const minusDM = Array(n).fill(0);

  for (let i = 1; i < n; i += 1) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i]  = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const range = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr[i] = Number.isFinite(range) ? range : 0;
  }

  // Wilder smoothing
  const smTr = Array(n).fill(null);
  const smPlus = Array(n).fill(null);
  const smMinus = Array(n).fill(null);
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i < n; i += 1) {
    if (i <= period) {
      trSum += tr[i];
      plusSum += plusDM[i];
      minusSum += minusDM[i];
      if (i === period) {
        smTr[i] = trSum;
        smPlus[i] = plusSum;
        smMinus[i] = minusSum;
      }
    } else {
      smTr[i]    = (smTr[i - 1]    - (smTr[i - 1] / period))    + tr[i];
      smPlus[i]  = (smPlus[i - 1]  - (smPlus[i - 1] / period))  + plusDM[i];
      smMinus[i] = (smMinus[i - 1] - (smMinus[i - 1] / period)) + minusDM[i];
    }
  }

  const pdi = Array(n).fill(null);
  const mdi = Array(n).fill(null);
  const dx  = Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    if (!Number.isFinite(smTr[i]) || smTr[i] === 0) continue;
    pdi[i] = (smPlus[i]  / smTr[i]) * 100;
    mdi[i] = (smMinus[i] / smTr[i]) * 100;
    const sum = pdi[i] + mdi[i];
    dx[i] = sum === 0 ? 0 : (Math.abs(pdi[i] - mdi[i]) / sum) * 100;
  }

  const adxLine = Array(n).fill(null);
  // Primer ADX = SMA(DX, period) anclado en idx = 2*period - 1
  let dxSum = 0;
  let count = 0;
  let firstAnchor = -1;
  for (let i = period; i < n; i += 1) {
    if (!Number.isFinite(dx[i])) continue;
    dxSum += dx[i];
    count += 1;
    if (count === period) {
      firstAnchor = i;
      adxLine[i] = dxSum / period;
      break;
    }
  }
  if (firstAnchor !== -1) {
    for (let i = firstAnchor + 1; i < n; i += 1) {
      if (!Number.isFinite(dx[i]) || !Number.isFinite(adxLine[i - 1])) continue;
      adxLine[i] = ((adxLine[i - 1] * (period - 1)) + dx[i]) / period;
    }
  }

  return {
    adx: adxLine.map((v) => (Number.isFinite(v) ? round(v) : null)),
    pdi: pdi.map((v)    => (Number.isFinite(v) ? round(v) : null)),
    mdi: mdi.map((v)    => (Number.isFinite(v) ? round(v) : null)),
  };
}

function keltner(input, params = {}) {
  const length = Math.max(1, Number(params.length) || 20);
  const atrLength = Math.max(1, Number(params.atrLength) || 10);
  const multiplier = Number(params.multiplier) || 1.5;
  const middleSeries = ema(input, { period: length, source: 'close' });
  const atrSeries = atr(input, { period: atrLength });
  return middleSeries.map((mid, index) => {
    const a = atrSeries[index];
    if (!Number.isFinite(mid) || !Number.isFinite(a)) {
      return { upper: null, middle: null, lower: null };
    }
    return {
      upper:  round(mid + multiplier * a),
      middle: round(mid),
      lower:  round(mid - multiplier * a),
    };
  });
}

function vwap(input) {
  // VWAP acumulativo desde el inicio del array (no por sesión).
  const { highs, lows, closes, volumes } = highsLowsCloses(input);
  const n = closes.length;
  let cumPV = 0;
  let cumV = 0;
  const out = Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    if (!Number.isFinite(typical) || !Number.isFinite(volumes[i])) continue;
    cumPV += typical * volumes[i];
    cumV  += volumes[i];
    if (cumV > 0) out[i] = round(cumPV / cumV);
  }
  return out;
}

// ------------------------------------------------------------------
// Squeeze Momentum (LazyBear) — port CJS desde client/.../sqzmom.js.
// Devuelve { momentum, sqzState, normalUpper, normalMiddle, normalLower }
// ------------------------------------------------------------------

function _smaAt(values, length, i) {
  if (i + 1 < length) return NaN;
  let sum = 0;
  for (let k = i - length + 1; k <= i; k += 1) sum += values[k];
  return sum / length;
}

function _stdevAt(values, length, i) {
  if (i + 1 < length) return NaN;
  const mean = _smaAt(values, length, i);
  let acc = 0;
  for (let k = i - length + 1; k <= i; k += 1) {
    const d = values[k] - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / length);
}

function _highestAt(values, length, i) {
  if (i + 1 < length) return NaN;
  let m = -Infinity;
  for (let k = i - length + 1; k <= i; k += 1) if (values[k] > m) m = values[k];
  return m;
}

function _lowestAt(values, length, i) {
  if (i + 1 < length) return NaN;
  let m = Infinity;
  for (let k = i - length + 1; k <= i; k += 1) if (values[k] < m) m = values[k];
  return m;
}

function _trueRange(highs, lows, closes, i) {
  if (i === 0) return highs[i] - lows[i];
  const prev = closes[i - 1];
  return Math.max(
    highs[i] - lows[i],
    Math.abs(highs[i] - prev),
    Math.abs(lows[i] - prev)
  );
}

function _linregAt(values, length, i, offset = 0) {
  if (i + 1 < length) return NaN;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let k = 0; k < length; k += 1) {
    const y = values[i - k];
    const x = length - 1 - k;
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

function _normalBands(momentum, params = {}) {
  const length = Math.max(2, Math.floor(Number(params.normalBandLength) || 100));
  const sigma = Math.max(0, Number(params.normalBandSigma) || 2);
  const normalUpper = new Array(momentum.length).fill(null);
  const normalMiddle = new Array(momentum.length).fill(null);
  const normalLower = new Array(momentum.length).fill(null);
  const window = [];

  for (let i = 0; i < momentum.length; i += 1) {
    const value = momentum[i];
    if (!Number.isFinite(value)) continue;

    window.push(value);
    if (window.length > length) window.shift();
    if (window.length < length) continue;

    const mean = window.reduce((sum, current) => sum + current, 0) / length;
    const variance = window.reduce((sum, current) => {
      const diff = current - mean;
      return sum + diff * diff;
    }, 0) / length;
    const spread = sigma * Math.sqrt(variance);

    normalUpper[i] = round(mean + spread);
    normalMiddle[i] = round(mean);
    normalLower[i] = round(mean - spread);
  }

  return { normalUpper, normalMiddle, normalLower };
}

function sqzmom(input, params = {}) {
  const length      = Math.max(2, Number(params.length) || 20);
  const lengthKC    = Math.max(2, Number(params.lengthKC) || 20);
  const multKC      = Number(params.multKC) || 1.5;
  const useTrueRange = params.useTrueRange !== false;
  const { highs, lows, closes } = highsLowsCloses(input);
  const n = closes.length;
  const range = new Array(n);
  for (let i = 0; i < n; i += 1) {
    range[i] = useTrueRange ? _trueRange(highs, lows, closes, i) : (highs[i] - lows[i]);
  }
  const delta = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const hh = _highestAt(highs, lengthKC, i);
    const ll = _lowestAt(lows, lengthKC, i);
    const sc = _smaAt(closes, lengthKC, i);
    if (!Number.isFinite(hh) || !Number.isFinite(ll) || !Number.isFinite(sc)) {
      delta[i] = NaN;
    } else {
      const avg1  = (hh + ll) / 2;
      const avg12 = (avg1 + sc) / 2;
      delta[i] = closes[i] - avg12;
    }
  }
  const momentum = new Array(n).fill(null);
  const sqzState = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const basis  = _smaAt(closes, length, i);
    const stdev  = _stdevAt(closes, length, i);
    const ma     = _smaAt(closes, lengthKC, i);
    const rangeMa = _smaAt(range, lengthKC, i);
    if (!Number.isFinite(basis) || !Number.isFinite(stdev) ||
        !Number.isFinite(ma)    || !Number.isFinite(rangeMa)) {
      continue;
    }
    const dev    = multKC * stdev; // bug "famoso" del Pine original — preservado
    const upBB   = basis + dev;
    const lowBB  = basis - dev;
    const upKC   = ma + rangeMa * multKC;
    const lowKC  = ma - rangeMa * multKC;
    const sqzOn  = lowBB > lowKC && upBB < upKC;
    const sqzOff = lowBB < lowKC && upBB > upKC;
    sqzState[i] = sqzOn ? 'on' : sqzOff ? 'off' : 'noSqz';
    const val = _linregAt(delta, lengthKC, i, 0);
    momentum[i] = Number.isFinite(val) ? round(val) : null;
  }
  return { momentum, sqzState, ..._normalBands(momentum, params) };
}

const BUILTIN_INDICATORS = {
  sma,
  ema,
  wma,
  rsi,
  macd,
  atr,
  adx,
  bollinger,
  keltner,
  stoch,
  vwap,
  sqzmom,
  last,
};

module.exports = {
  BUILTIN_INDICATORS,
  adx,
  atr,
  bollinger,
  ema,
  keltner,
  last,
  macd,
  rsi,
  sma,
  sqzmom,
  stoch,
  toSeries,
  vwap,
  wma,
};
