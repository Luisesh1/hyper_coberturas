const HyperliquidService = require('../hyperliquid.service');

const client = new HyperliquidService();

const SUPPORTED_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M']);

async function fetchCandles({ symbol, timeframe, startTime, endTime }) {
  if (!SUPPORTED_INTERVALS.has(timeframe)) {
    throw new Error(`hyperliquid: timeframe ${timeframe} no soportado`);
  }
  const rows = await client.getCandleSnapshot({
    asset: symbol,
    interval: timeframe,
    startTime,
    endTime,
  });
  if (!Array.isArray(rows)) return [];
  return rows.map((c) => ({
    time: Number(c.t),
    closeTime: Number(c.T),
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
    volume: Number(c.v || 0),
    trades: Number(c.n || 0),
  }));
}

module.exports = {
  name: 'hyperliquid',
  supportedIntervals: [...SUPPORTED_INTERVALS],
  fetchCandles,
};
