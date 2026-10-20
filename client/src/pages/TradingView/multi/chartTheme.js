// Tema y helpers de precio compartidos por la vista multi-temporalidad.
// Copiados de TradingViewPage.jsx (que no se toca) para mantener el mismo
// aspecto sin acoplar ambas páginas.

export const DEFAULT_PRICE_PRECISION = 2;

// Intervalo de polling en tiempo real por timeframe.
// Compromiso entre frescura y carga de red (el backend cachea 10s).
export const LIVE_POLL_MS = {
  '1m':  3_000,
  '5m':  5_000,
  '15m': 8_000,
  '1h':  15_000,
  '4h':  30_000,
  '1d':  60_000,
  '1w':  300_000,
  '1M':  600_000,
};

export const THEME = {
  background: '#0f1114',
  text: '#b3b8c2',
  grid: 'rgba(120, 130, 145, 0.08)',
  border: 'rgba(120, 130, 145, 0.25)',
  up: '#26a69a',
  down: '#ef5350',
  upEdge: '#39c8b9',
  downEdge: '#ff6b68',
};

// Valores por defecto de lightweight-charts 5.1 para las líneas del puntero
// (se restauran cuando no hay puntero sincronizado).
export const DEFAULT_CROSSHAIR_LINE = {
  color: '#9598A1',
  style: 3, // LineStyle.LargeDashed
  labelBackgroundColor: '#131722',
};

// Formatea un precio con decimales adaptativos al orden de magnitud.
// 70,510.73 (BTC) | 2,348.7 (ETH) | 145.62 | 0.85432 | 0.0000123
export function getPricePrecisionFromValue(value) {
  const abs = Math.abs(Number(value));
  if (!Number.isFinite(abs) || abs === 0) return DEFAULT_PRICE_PRECISION;
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  return 8;
}

export function getPricePrecisionFromCandles(candles = []) {
  const minPrice = candles.reduce((min, candle) => {
    const values = [candle?.open, candle?.high, candle?.low, candle?.close]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (values.length === 0) return min;
    return Math.min(min, ...values);
  }, Infinity);
  return Number.isFinite(minPrice) ? getPricePrecisionFromValue(minPrice) : DEFAULT_PRICE_PRECISION;
}

export function getPriceFormatOptions(precision) {
  return {
    type: 'price',
    precision,
    minMove: precision > 0 ? 10 ** -precision : 1,
  };
}

export function formatPrice(n, precision = getPricePrecisionFromValue(n)) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision >= 4 ? 0 : precision,
  });
}
