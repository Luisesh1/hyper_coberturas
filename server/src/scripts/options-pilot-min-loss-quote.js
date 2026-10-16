/**
 * Consulta pública, sin órdenes: estima el desembolso máximo de una
 * compra BUY de tamaño mínimo entre opciones ETH con spread/profundidad.
 * Esta estimación NO certifica la pérdida máxima en USD ni una estrategia
 * rentable. Pueden existir spreads, tasas y cambios de precio.
 */
const { createBinanceOptionsClient } = require('../services/options/binance-options.client');
const { requireOrderFilters } = require('../services/options/options-order-filters');

const MAX_SEARCH_BUDGET_USDT = 20;
const MAX_SPREAD_RATIO = 0.10;
const MIN_DTE_MS = 2 * 24 * 60 * 60_000;
const MAX_BOOK_CALLS = 12;

const pos = x => x !== null && x !== undefined && x !== '' &&
  Number.isFinite(Number(x)) && Number(x) > 0;
const ceilCents = x => Math.ceil((x - 1e-10) * 100) / 100;

function candidateList(info, tickers, at = Date.now()) {
  if (!Array.isArray(info?.optionSymbols) || !Array.isArray(tickers)) return [];
  const market = new Map(tickers.filter(t => typeof t?.symbol === 'string')
    .map(t => [t.symbol, t]));
  const out = [];
  for (const option of info.optionSymbols) {
    if (option?.underlying !== 'ETHUSDT' || option.status !== 'TRADING' ||
        option.quoteAsset !== 'USDT' ||
        !/^ETH-\d{6}-[\d.]+-[CP]$/.test(option.symbol || '') ||
        !pos(option.unit) || !(Number(option.expiryDate) > at + MIN_DTE_MS)) continue;
    const t = market.get(option.symbol);
    const ask = Number(t?.askPrice), bid = Number(t?.bidPrice);
    if (!(ask > 0) || !(bid > 0) || bid > ask ||
        (ask - bid) / ask > MAX_SPREAD_RATIO) continue;
    const pf = option.filters?.find(f => f.filterType === 'PRICE_FILTER');
    const lf = option.filters?.find(f => f.filterType === 'LOT_SIZE') || pf;
    const quantity = lf?.minQty;
    if (!pos(quantity)) continue;
    try {
      requireOrderFilters(info, {
        symbol: option.symbol, price: String(t.askPrice), quantity: String(quantity),
      }, at, at + 10 * 60_000);
    } catch (_) { continue; }

    // Multiplicador conservador para contratos con unit>1; si Binance
    // muestra otro nocional efectivo, esta estimación NO sirve para operar.
    const grossPremiumProxy = ask * Number(quantity) * Math.max(1, Number(option.unit));
    if (!Number.isFinite(grossPremiumProxy) || grossPremiumProxy <= 0) continue;
    // Comisión de entrada: hasta 10% de prima según FAQ de Binance.
    // La conversión USD/USDT, los costes efectivos y el preview del
    // exchange siguen siendo controles pendientes.
    const upperEntryCost = ceilCents(grossPremiumProxy * 1.10);
    if (upperEntryCost > MAX_SEARCH_BUDGET_USDT) continue;
    out.push({
      symbol: option.symbol, ask, bid, quantity: Number(quantity),
      upperEntryCost, expiry: Number(option.expiryDate),
    });
  }
  return out.sort((a, b) =>
    a.upperEntryCost - b.upperEntryCost || a.expiry - b.expiry);
}

function bookHasTwoWayLiquidity(book, quantity, quotedAsk = null) {
  if (!book || !Array.isArray(book.asks) || !Array.isArray(book.bids)) return false;
  const levels = rows => rows.filter(x => Array.isArray(x) && pos(x[0]) && pos(x[1]))
    .map(x => ({ price: Number(x[0]), qty: Number(x[1]) }));
  const asks = levels(book.asks).sort((a, b) => a.price - b.price);
  const bids = levels(book.bids).sort((a, b) => b.price - a.price);
  if (!asks.length || !bids.length || asks[0].price <= bids[0].price ||
      asks[0].qty < quantity || bids[0].qty < quantity ||
      (asks[0].price - bids[0].price) / asks[0].price > MAX_SPREAD_RATIO) return false;
  // Nunca estimar prima inferior al precio ejecutable más reciente.
  if (quotedAsk !== null && asks[0].price > quotedAsk + 1e-10) return false;
  return true;
}

async function minLossScan(client, at = Date.now()) {
  const [info, tickers] = await Promise.all([
    client.getExchangeInfo(), client.getTicker(),
  ]);
  const eligible = candidateList(info, tickers, at);
  let liquidCandidates = 0;
  let best = null;
  for (const candidate of eligible.slice(0, MAX_BOOK_CALLS)) {
    let depth;
    try { depth = await client.getDepth(candidate.symbol, 10); }
    catch (_) { continue; }
    if (!bookHasTwoWayLiquidity(depth, candidate.quantity, candidate.ask)) continue;
    liquidCandidates++;
    if (!best || candidate.upperEntryCost < best.upperEntryCost) {
      best = candidate;
    }
  }
  return {
    readOnly: true,
    pilotReady: false,
    maxSearchBudgetUsdt: MAX_SEARCH_BUDGET_USDT,
    affordableLiquid: liquidCandidates > 0,
    minimumEstimatedUpperEntryCostUsdt: best?.upperEntryCost ?? null,
    // Nunca imprimir símbolo, cantidades, mark price, saldo o API keys.
  };
}

function sanitizedLines(report) {
  if (!report || report.readOnly !== true || report.pilotReady !== false ||
      report.maxSearchBudgetUsdt !== MAX_SEARCH_BUDGET_USDT ||
      typeof report.affordableLiquid !== 'boolean' ||
      (report.affordableLiquid &&
        (!Number.isFinite(report.minimumEstimatedUpperEntryCostUsdt) ||
         !(report.minimumEstimatedUpperEntryCostUsdt > 0) ||
         report.minimumEstimatedUpperEntryCostUsdt > MAX_SEARCH_BUDGET_USDT)) ||
      (!report.affordableLiquid && report.minimumEstimatedUpperEntryCostUsdt !== null)) {
    throw new Error('Invalid quote estimate');
  }
  return [
    'pilot_min_loss_scan=' + (report.affordableLiquid ? 'pass' : 'unverified'),
    'pilot_smallest_liquid_entry_estimate_usdt=' +
      (report.affordableLiquid ? report.minimumEstimatedUpperEntryCostUsdt.toFixed(2) : 'unverified'),
    'pilot_effective_fees=unverified',
    'pilot_usd_conversion=unverified',
    'pilot_operator_approval=unverified',
    'pilot_ready=no',
  ];
}

if (require.main === module) {
  minLossScan(createBinanceOptionsClient())
    .then(result => {
      for (const line of sanitizedLines(result)) console.log(line);
    })
    .catch(() => {
      console.log('pilot_min_loss_scan=unavailable');
      process.exitCode = 1;
    });
}

module.exports = { candidateList, bookHasTwoWayLiquidity, minLossScan, sanitizedLines };
