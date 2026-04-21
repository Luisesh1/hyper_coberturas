// Proveedor de Yahoo Finance usando el paquete oficial comunitario
// `yahoo-finance2`. Sin API key; cubre indices (SPX, NDX), commodities
// (oro, petroleo), stocks, forex. Útil para complementar lo que no está
// en Hyperliquid/Binance.

// En v3 el paquete expone una clase YahooFinance; se instancia una vez.
const YahooFinance = require('yahoo-finance2').default;
const yahooFinanceDefault = new YahooFinance();

// Yahoo permite estos intervalos; mapeamos los nuestros a su formato.
// Para intervalos muy granulares hay limites de ventana (ej 1m solo 7d).
const INTERVAL_MAP = {
  '1m':  { yahoo: '1m',  windowDays: 7 },
  '5m':  { yahoo: '5m',  windowDays: 60 },
  '15m': { yahoo: '15m', windowDays: 60 },
  '1h':  { yahoo: '60m', windowDays: 730 },
  '4h':  null, // Yahoo no expone 4h; fallback al caller
  '1d':  { yahoo: '1d',  windowDays: 365 * 20 },
  '1w':  { yahoo: '1wk', windowDays: 365 * 20 },
  '1M':  { yahoo: '1mo', windowDays: 365 * 30 },
};

try {
  // Silencia warnings "survey" que el paquete imprime al init.
  yahooFinanceDefault.suppressNotices?.(['yahooSurvey', 'ripHistorical']);
} catch { /* noop */ }

async function fetchCandles({ symbol, timeframe, startTime, endTime }) {
  const cfg = INTERVAL_MAP[timeframe];
  if (!cfg) {
    throw new Error(`yahoo: timeframe ${timeframe} no soportado`);
  }
  const now = Date.now();
  const end = new Date(endTime || now);
  const minStart = now - cfg.windowDays * 24 * 60 * 60 * 1000;
  const startMs = Math.max(startTime || minStart, minStart);
  const start = new Date(startMs);

  const result = await yahooFinanceDefault.chart(String(symbol), {
    period1: start,
    period2: end,
    interval: cfg.yahoo,
    // Permite fetch de indices, forex, futures via sus sufijos (^, =X, =F).
  });

  const quotes = result?.quotes || [];
  return quotes
    .filter((q) => q && q.date && Number.isFinite(Number(q.close)))
    .map((q) => {
      const t = new Date(q.date).getTime();
      return {
        time: t,
        closeTime: t,
        open: Number(q.open ?? q.close),
        high: Number(q.high ?? q.close),
        low: Number(q.low ?? q.close),
        close: Number(q.close),
        volume: Number(q.volume || 0),
        trades: 0,
      };
    });
}

module.exports = {
  name: 'yahoo',
  supportedIntervals: Object.keys(INTERVAL_MAP).filter((k) => INTERVAL_MAP[k]),
  fetchCandles,
};
