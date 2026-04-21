import {
  SMA, EMA, WMA, RSI, MACD, BollingerBands, ATR, ADX, Stochastic,
} from 'technicalindicators';
import { computeSqueezeMomentum } from '../sqzmom';

// Las candles que llegan traen `time` en segundos (ya convertido en TradingViewPage)
// o en milisegundos (crudo del server). `time` de salida: segundos (formato lightweight-charts).

function toSec(candle) {
  const t = Number(candle.time);
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
}

function mapCloses(candles) { return candles.map((c) => Number(c.close)); }
function mapHighs(candles) { return candles.map((c) => Number(c.high)); }
function mapLows(candles) { return candles.map((c) => Number(c.low)); }
function mapOpens(candles) { return candles.map((c) => Number(c.open)); }
function mapVolumes(candles) { return candles.map((c) => Number(c.volume || 0)); }

// `technicalindicators` devuelve arrays desplazados: los primeros N-1 elementos
// faltan. Alineamos al `time` de las últimas N candles.
function alignRight(candles, values) {
  const offset = candles.length - values.length;
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    out.push({ time: toSec(candles[offset + i]), value: values[i] });
  }
  return out;
}

function alignRightObjects(candles, objects, pick) {
  const offset = candles.length - objects.length;
  const out = [];
  for (let i = 0; i < objects.length; i += 1) {
    const v = pick(objects[i]);
    if (v == null) continue;
    out.push({ time: toSec(candles[offset + i]), value: Number(v) });
  }
  return out;
}

function computeVwap(candles) {
  // Running VWAP sin reset de sesión (simple). Para reset diario habría
  // que agruparlos por fecha UTC; este MVP usa el acumulado total.
  let cumPV = 0;
  let cumV = 0;
  const result = [];
  for (const c of candles) {
    const typical = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const vol = Number(c.volume || 0);
    cumPV += typical * vol;
    cumV += vol;
    if (cumV > 0) result.push({ time: toSec(c), value: cumPV / cumV });
  }
  return result;
}

function computeKeltner(candles, { length = 20, atrLength = 10, multiplier = 1.5 } = {}) {
  // Middle = EMA(close, length); Upper/Lower = Middle ± mult * ATR(atrLength)
  const closes = mapCloses(candles);
  const highs = mapHighs(candles);
  const lows = mapLows(candles);

  const emaArr = EMA.calculate({ period: length, values: closes });
  const atrArr = ATR.calculate({ period: atrLength, high: highs, low: lows, close: closes });

  // Alineamos por la derecha (el más corto fija el inicio)
  const len = Math.min(emaArr.length, atrArr.length);
  const emaSlice = emaArr.slice(emaArr.length - len);
  const atrSlice = atrArr.slice(atrArr.length - len);
  const offset = candles.length - len;

  const middle = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < len; i += 1) {
    const t = toSec(candles[offset + i]);
    middle.push({ time: t, value: emaSlice[i] });
    upper.push({ time: t, value: emaSlice[i] + multiplier * atrSlice[i] });
    lower.push({ time: t, value: emaSlice[i] - multiplier * atrSlice[i] });
  }
  return { middle, upper, lower };
}

// ------------------------------------------------------------------
// Dispatcher principal
// ------------------------------------------------------------------

export function computeIndicator(type, candles, params = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const closes = mapCloses(candles);
  const highs = mapHighs(candles);
  const lows = mapLows(candles);

  switch (type) {
    case 'sma': {
      const v = SMA.calculate({ period: params.length || 20, values: closes });
      return { series: [{ role: 'line', data: alignRight(candles, v) }] };
    }
    case 'ema': {
      const v = EMA.calculate({ period: params.length || 20, values: closes });
      return { series: [{ role: 'line', data: alignRight(candles, v) }] };
    }
    case 'wma': {
      const v = WMA.calculate({ period: params.length || 20, values: closes });
      return { series: [{ role: 'line', data: alignRight(candles, v) }] };
    }
    case 'rsi': {
      const v = RSI.calculate({ period: params.length || 14, values: closes });
      return { series: [{ role: 'line', data: alignRight(candles, v) }] };
    }
    case 'atr': {
      const v = ATR.calculate({ period: params.length || 14, high: highs, low: lows, close: closes });
      return { series: [{ role: 'line', data: alignRight(candles, v) }] };
    }
    case 'macd': {
      const out = MACD.calculate({
        values: closes,
        fastPeriod: params.fast || 12,
        slowPeriod: params.slow || 26,
        signalPeriod: params.signal || 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      return {
        series: [
          { role: 'macd', data: alignRightObjects(candles, out, (o) => o.MACD) },
          { role: 'signal', data: alignRightObjects(candles, out, (o) => o.signal) },
          { role: 'histogram', data: alignRightObjects(candles, out, (o) => o.histogram) },
        ],
      };
    }
    case 'stoch': {
      const out = Stochastic.calculate({
        high: highs, low: lows, close: closes,
        period: params.kLength || 14,
        signalPeriod: params.dLength || 3,
      });
      return {
        series: [
          { role: 'k', data: alignRightObjects(candles, out, (o) => o.k) },
          { role: 'd', data: alignRightObjects(candles, out, (o) => o.d) },
        ],
      };
    }
    case 'adx': {
      const out = ADX.calculate({
        high: highs, low: lows, close: closes,
        period: params.length || 14,
      });
      return {
        series: [
          { role: 'adx', data: alignRightObjects(candles, out, (o) => o.adx) },
          { role: 'pdi', data: alignRightObjects(candles, out, (o) => o.pdi) },
          { role: 'mdi', data: alignRightObjects(candles, out, (o) => o.mdi) },
        ],
      };
    }
    case 'bollinger': {
      const out = BollingerBands.calculate({
        period: params.length || 20,
        stdDev: params.stdDev || 2,
        values: closes,
      });
      return {
        series: [
          { role: 'upper', data: alignRightObjects(candles, out, (o) => o.upper) },
          { role: 'middle', data: alignRightObjects(candles, out, (o) => o.middle) },
          { role: 'lower', data: alignRightObjects(candles, out, (o) => o.lower) },
        ],
      };
    }
    case 'keltner': {
      const { middle, upper, lower } = computeKeltner(candles, params);
      return {
        series: [
          { role: 'upper', data: upper },
          { role: 'middle', data: middle },
          { role: 'lower', data: lower },
        ],
      };
    }
    case 'vwap': {
      return { series: [{ role: 'line', data: computeVwap(candles) }] };
    }
    case 'volume': {
      const data = candles.map((c) => ({
        time: toSec(c),
        value: Number(c.volume || 0),
        color: Number(c.close) >= Number(c.open) ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
      }));
      return { series: [{ role: 'histogram', data }] };
    }
    case 'sqzmom': {
      // Preserva comportamiento existente: candles con `time` en ms.
      const sqz = computeSqueezeMomentum(candles, params);
      const valid = sqz.filter((p) => p && p.value != null);
      const hist = valid.map((p) => ({ time: p.time, value: p.value, color: p.color }));
      return {
        series: [
          { role: 'histogram', data: hist },
          { role: 'sqzDots', data: buildSqzDots(valid) },
        ],
      };
    }
    default:
      return null;
  }
}

function buildSqzDots(points) {
  // Usa un punto por cada vela en y=0 con color según estado de squeeze.
  return points.map((p) => ({
    time: p.time,
    value: 0,
    color: p.noSqz ? '#2962ff' : (p.sqzOn ? '#000000' : '#a6a6a6'),
  }));
}
