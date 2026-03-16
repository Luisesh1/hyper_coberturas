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

const BUILTIN_INDICATORS = {
  sma,
  ema,
  rsi,
  macd,
  atr,
  bollinger,
  last,
};

module.exports = {
  BUILTIN_INDICATORS,
  atr,
  bollinger,
  ema,
  last,
  macd,
  rsi,
  sma,
  toSeries,
};
