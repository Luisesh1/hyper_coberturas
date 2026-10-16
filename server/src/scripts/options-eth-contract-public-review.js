/**
 * Consulta pública de opciones ETH con delta, IV, bid/ask, tamaño mínimo y
 * coste de entrada. NO autenticación, órdenes, DB ni activación de trading.
 * Delta no es una estimación directa de probabilidad de beneficio.
 * Prima = precio de opción * tamaño negociado. unit se usa en la
 * fórmula de fee basada en índice, no multiplica otra vez la prima.
 */
const { createBinanceOptionsClient } = require('../services/options/binance-options.client');
const { requireOrderFilters } = require('../services/options/options-order-filters');

const HARD_SCREEN_USDT = 20;
const MAX_SPREAD = 0.10;
const MIN_DELTA = 0.25;
const MAX_DELTA = 0.75;
const MIN_DTE = 3;
const MAX_DTE = 30;
const MAX_BOOKS = 12;
const DAY_MS = 86400000;
const positive = x => x !== undefined && x !== null && x !== '' &&
  Number.isFinite(Number(x)) && Number(x) > 0;
const ceilCents = n => Math.ceil((n - 1e-10) * 100) / 100;

function findCandidates({ exchange, tickers, marks, index, at }) {
  if (!Array.isArray(exchange?.optionSymbols) ||
      !Array.isArray(tickers) || !Array.isArray(marks) ||
      !positive(index?.indexPrice)) return [];
  const prices = new Map(tickers.filter(t => t && typeof t.symbol === 'string')
    .map(t => [t.symbol, t]));
  const greeks = new Map(marks.filter(m => m && typeof m.symbol === 'string')
    .map(m => [m.symbol, m]));
  const out = [];
  for (const item of exchange.optionSymbols) {
    if (item?.status !== 'TRADING' || item.underlying !== 'ETHUSDT' ||
        item.quoteAsset !== 'USDT' || !positive(item.unit) ||
        !/^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(item.symbol || '')) continue;
    const dte = (Number(item.expiryDate) - at) / DAY_MS;
    if (!Number.isFinite(dte) || dte < MIN_DTE || dte > MAX_DTE) continue;
    const ticker = prices.get(item.symbol);
    const mark = greeks.get(item.symbol);
    if (!positive(ticker?.bidPrice) || !positive(ticker?.askPrice) ||
        !positive(mark?.markPrice) || !positive(mark?.markIV) ||
        !Number.isFinite(Number(mark?.delta))) continue;
    const delta = Number(mark.delta);
    const abs = Math.abs(delta);
    const type = item.symbol.endsWith('-C') ? 'CALL' : 'PUT';
    if (abs < MIN_DELTA || abs > MAX_DELTA ||
        (type === 'CALL' && delta <= 0) || (type === 'PUT' && delta >= 0)) continue;
    const bid = Number(ticker.bidPrice), ask = Number(ticker.askPrice);
    if (bid > ask || (ask - bid) / ask > MAX_SPREAD) continue;
    const pf = item.filters?.find(f => f.filterType === 'PRICE_FILTER');
    const lf = item.filters?.find(f => f.filterType === 'LOT_SIZE') || pf;
    if (!positive(lf?.minQty)) continue;
    const quantity = Number(lf.minQty);
    try {
      requireOrderFilters(exchange, {
        symbol: item.symbol, price: String(ticker.askPrice),
        quantity: String(lf.minQty),
      }, at, at + 600000);
    } catch (_) { continue; }
    const premium = ask * quantity;
    // Ahorro máximo de fee: 10% de prima según FAQ; tarifa efectiva pendiente.
    const worstEntryEstimate = ceilCents(premium * 1.10);
    if (!positive(premium) || worstEntryEstimate > HARD_SCREEN_USDT) continue;
    const strike = Number(item.strikePrice ?? item.symbol.split('-')[2]);
    if (!positive(strike)) continue;
    out.push({ symbol: item.symbol, type, expiry: Number(item.expiryDate),
      strike, bid, ask, quantity, unit: Number(item.unit), delta,
      iv: Number(mark.markIV), spread: (ask-bid)/ask, worstEntryEstimate });
  }
  return out.sort((a,b) => a.worstEntryEstimate-b.worstEntryEstimate ||
    Math.abs(a.delta)-Math.abs(b.delta) || a.expiry-b.expiry);
}

function executableBook(book, c) {
  if (!Array.isArray(book?.asks) || !Array.isArray(book?.bids)) return false;
  const levels = side => side.filter(x => Array.isArray(x) &&
    positive(x[0]) && positive(x[1]))
    .map(x => ({ price: Number(x[0]), qty: Number(x[1]) }));
  const asks = levels(book.asks).sort((a,b) => a.price-b.price);
  const bids = levels(book.bids).sort((a,b) => b.price-a.price);
  return Boolean(asks.length && bids.length &&
    asks[0].qty >= c.quantity && bids[0].qty >= c.quantity &&
    asks[0].price <= c.ask + 1e-9 &&
    bids[0].price < asks[0].price &&
    (asks[0].price - bids[0].price)/asks[0].price <= MAX_SPREAD);
}

async function review(client, at = Date.now()) {
  const [exchange, tickers, marks, index] = await Promise.all([
    client.getExchangeInfo(), client.getTicker(), client.getMark(),
    client.getIndex('ETHUSDT'),
  ]);
  const input = findCandidates({ exchange, tickers, marks, index, at });
  const selected = [];
  for (const c of input.slice(0,MAX_BOOKS)) {
    let book;
    try { book=await client.getDepth(c.symbol,10); } catch (_) { continue; }
    if (executableBook(book,c)) selected.push(c);
    if (selected.length>=3) break;
  }
  return { readOnly: true, pilotReady: false,
    index: Number(index.indexPrice), booksSampled: Math.min(input.length,MAX_BOOKS),
    marketSnapshotAt: at, candidates: selected };
}

function outputLines(result) {
  if (!result || result.readOnly !== true || result.pilotReady !== false ||
      !positive(result.index) || !Number.isSafeInteger(result.booksSampled) ||
      result.booksSampled < 0 || result.booksSampled > MAX_BOOKS ||
      !Number.isFinite(result.marketSnapshotAt) ||
      !Array.isArray(result.candidates) || result.candidates.length > 3 ||
      result.candidates.some(c =>
        !/^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(c.symbol) ||
        !positive(c.ask) || !positive(c.quantity) || !positive(c.unit) ||
        !positive(c.worstEntryEstimate) || c.worstEntryEstimate > HARD_SCREEN_USDT ||
        !positive(c.iv) || !Number.isFinite(c.delta) ||
        Math.abs(c.delta) < MIN_DELTA || Math.abs(c.delta) > MAX_DELTA)) {
    throw new Error('Invalid contract review');
  }
  const fmt = (n,d) => Number(n).toFixed(d);
  const lines = [
    'review_read_only=pass',
    'review_status='+(result.candidates.length?'candidates':'no_candidate'),
    'review_eth_index_usdt='+fmt(result.index,2),
    'review_books_sampled='+result.booksSampled,
    'review_snapshot_at='+new Date(result.marketSnapshotAt).toISOString(),
  ];
  for (const [i,c] of result.candidates.entries()) {
    const prefix='review_candidate_'+(i+1)+'_';
    // Solo datos de mercado públicos. Nunca IDs privados, balances o API keys.
    lines.push(prefix+'symbol='+c.symbol);
    lines.push(prefix+'type='+c.type);
    lines.push(prefix+'expiry='+new Date(c.expiry).toISOString());
    lines.push(prefix+'strike='+c.strike);
    lines.push(prefix+'unit='+c.unit);
    lines.push(prefix+'min_qty='+c.quantity);
    lines.push(prefix+'bid_usdt='+c.bid);
    lines.push(prefix+'ask_usdt='+c.ask);
    lines.push(prefix+'spread_pct='+fmt(c.spread*100,2));
    lines.push(prefix+'delta='+fmt(c.delta,4));
    lines.push(prefix+'iv_pct='+fmt(c.iv*100,2));
    lines.push(prefix+'entry_cost_cap_usdt='+fmt(c.worstEntryEstimate,2));
  }
  lines.push('review_effective_fees=unverified');
  lines.push('review_usd_conversion=unverified');
  lines.push('review_operator_approval=unverified');
  lines.push('pilot_ready=no');
  return lines;
}

if (require.main===module) {
  review(createBinanceOptionsClient()).then(r => {
    for (const line of outputLines(r)) console.log(line);
    if (!r.candidates.length) console.log('review_decision=NO_TRADE');
  }).catch(() => {
    console.log('review_status=unavailable');
    process.exitCode=1;
  });
}

module.exports = { findCandidates, executableBook, review,
  outputLines, HARD_SCREEN_USDT };
