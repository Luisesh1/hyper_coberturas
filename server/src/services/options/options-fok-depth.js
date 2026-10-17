/**
 * Pilot-only fail-closed FOK exit price from a fresh Binance Options order book.
 * This is a liquidity preflight, never a fill guarantee. No orders are sent here.
 */
const positive = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
};
const MAX_DEPTH_AGE_MS = 10_000;
const FUTURE_TOLERANCE_MS = 2_000;
const MAX_ADVERSE_SLIPPAGE_PCT = 10;

function fullSizeFokLimit({ book, side, quantity, nowMs, maxAdversePct = MAX_ADVERSE_SLIPPAGE_PCT }) {
  const requested = positive(quantity);
  if (!['BUY', 'SELL'].includes(side) || requested == null ||
      !Number.isFinite(nowMs) || !Number.isFinite(maxAdversePct) ||
      maxAdversePct < 0 || maxAdversePct > MAX_ADVERSE_SLIPPAGE_PCT) {
    throw new Error('Invalid FOK depth preflight input');
  }
  const timestamp = Number(book?.T);
  if (book?.T == null || !Number.isFinite(timestamp) ||
      timestamp < nowMs - MAX_DEPTH_AGE_MS ||
      timestamp > nowMs + FUTURE_TOLERANCE_MS) {
    throw new Error('FOK depth snapshot missing or stale');
  }
  if (!Array.isArray(book?.bids) || !Array.isArray(book?.asks) ||
      !book.bids.length || !book.asks.length) {
    throw new Error('FOK depth has no two-sided book');
  }
  const topBid = positive(book.bids[0]?.[0]);
  const topAsk = positive(book.asks[0]?.[0]);
  if (topBid == null || topAsk == null || topBid >= topAsk) {
    throw new Error('FOK depth crossed or invalid');
  }
  const levels = side === 'SELL' ? book.bids : book.asks;
  const best = side === 'SELL' ? topBid : topAsk;
  let previous = null;
  let available = 0;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) {
      throw new Error('Malformed FOK depth level');
    }
    const price = positive(level[0]);
    const amount = positive(level[1]);
    if (price == null || amount == null ||
        (previous != null && (side === 'SELL' ? price > previous : price < previous))) {
      throw new Error('Invalid or unsorted FOK depth levels');
    }
    previous = price;
    const adversePct = 100 * (side === 'SELL' ? (best - price) / best : (price - best) / best);
    if (adversePct > maxAdversePct + 1e-10) {
      throw new Error('FOK close exceeds maximum adverse book slippage');
    }
    available += amount;
    if (available + 1e-12 >= requested) return price;
  }
  throw new Error('Insufficient visible book liquidity for full FOK close');
}

module.exports = { fullSizeFokLimit, MAX_ADVERSE_SLIPPAGE_PCT };
