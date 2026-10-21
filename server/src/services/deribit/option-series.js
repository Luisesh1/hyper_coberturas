// Transformaciones puras de velas de opciones de Deribit (sin I/O).

const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

const RESOLUCIONES = {
  '1m': { resolution: '1', aggregateMs: null, calendar: null },
  '5m': { resolution: '5', aggregateMs: null, calendar: null },
  '15m': { resolution: '15', aggregateMs: null, calendar: null },
  '1h': { resolution: '60', aggregateMs: null, calendar: null },
  '4h': { resolution: '60', aggregateMs: 4 * HORA_MS, calendar: null },
  '1d': { resolution: '1D', aggregateMs: null, calendar: null },
  '1w': { resolution: '1D', aggregateMs: null, calendar: 'week' },
  '1M': { resolution: '1D', aggregateMs: null, calendar: 'month' },
};

// Temporalidad de la app -> resolución de Deribit y regla de agregación.
function resolutionFor(timeframe) {
  const r = RESOLUCIONES[timeframe];
  if (!r) throw new Error(`Temporalidad no soportada: ${timeframe}`);
  return { ...r };
}

// Zipea el formato columnar de get_tradingview_chart_data en velas (time en ms).
function chartDataToCandles(chartData) {
  const ticks = chartData?.ticks;
  if (!Array.isArray(ticks)) return [];
  return ticks.map((time, i) => {
    const volume = Number(chartData.volume?.[i]) || 0;
    return {
      time,
      open: chartData.open[i],
      high: chartData.high[i],
      low: chartData.low[i],
      close: chartData.close[i],
      volume,
      traded: volume > 0,
    };
  });
}

// Inicio del cubo de una vela: múltiplos de 4h, lunes 00:00 UTC o día 1 UTC.
function bucketStart(time, { aggregateMs, calendar }) {
  if (aggregateMs) return Math.floor(time / aggregateMs) * aggregateMs;
  const dia = Math.floor(time / DIA_MS) * DIA_MS;
  if (calendar === 'week') {
    const desdeLunes = (new Date(dia).getUTCDay() + 6) % 7;
    return dia - desdeLunes * DIA_MS;
  }
  const d = new Date(time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// Agrega velas a 4h, 1w o 1M (OHLC estándar). Sin regla de agregación devuelve la entrada.
function aggregateCandles(candles, timeframe) {
  const rule = resolutionFor(timeframe);
  if (!rule.aggregateMs && !rule.calendar) return candles;
  const cubos = new Map();
  for (const c of candles) {
    const t = bucketStart(c.time, rule);
    const a = cubos.get(t);
    if (!a) {
      cubos.set(t, { ...c, time: t });
    } else {
      a.high = Math.max(a.high, c.high);
      a.low = Math.min(a.low, c.low);
      a.close = c.close;
      a.volume += c.volume;
      a.traded = a.traded || c.traded;
    }
  }
  return [...cubos.values()];
}

// Pasa la prima a USD. Inversas: precio en moneda x cierre del perpetuo; sin cierre, se descarta.
function toUsdCandles(candles, { inverse, underlyingCloseByTime }) {
  if (!inverse) return candles;
  const out = [];
  for (const c of candles) {
    const px = underlyingCloseByTime?.get(c.time);
    if (!(px > 0)) continue;
    out.push({
      ...c,
      open: c.open * px,
      high: c.high * px,
      low: c.low * px,
      close: c.close * px,
      premiumCoin: c.close,
    });
  }
  return out;
}

module.exports = { resolutionFor, chartDataToCandles, aggregateCandles, toUsdCandles };
