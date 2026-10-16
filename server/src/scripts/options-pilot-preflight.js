/**
 * Preflight READ-ONLY de un piloto supervisado de Binance Options ETH.
 * GETs públicos/firmados. Nunca POST/DELETE ni cambios DB. No publica
 * saldos, órdenes, símbolos elegidos, precios, posiciones o identificadores.
 * No autoriza operar: los costes y la operación concreta requieren revisión
 * y aprobación humana por separado.
 */
const credentials = require('../services/options/options-credentials.service');
const { requireOrderFilters } = require('../services/options/options-order-filters');

const MAX_DEADLINE_MS = 10 * 60_000;
const MIN_TIME_TO_EXPIRY_MS = 24 * 60 * 60_000;
const CHECK_NAMES = Object.freeze([
  'liveFlagsOff', 'ethContracts', 'exchangeFilters', 'quotedLots',
  'depth', 'accountReadable', 'apiPermissions', 'isolatedAccount',
]);
const PENDING_NAMES = Object.freeze([
  'chosenContract', 'effectiveFees', 'riskBudget', 'operatorApproval',
]);

const positive = v => v !== null && v !== undefined && v !== '' &&
  Number.isFinite(Number(v)) && Number(v) > 0;

function validBook(book) {
  return book && Array.isArray(book.asks) && Array.isArray(book.bids) &&
    book.asks.some(l => Array.isArray(l) && positive(l[0]) && positive(l[1])) &&
    book.bids.some(l => Array.isArray(l) && positive(l[0]) && positive(l[1]));
}

function accountIsolated(positions, openOrders) {
  return Array.isArray(positions) && Array.isArray(openOrders) &&
    openOrders.length === 0 && positions.every(p =>
      p && positiveOrZero(p.quantity) && Math.abs(Number(p.quantity)) <= 1e-12
    );
}

function positiveOrZero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function eligibleEthContracts(exchange, ticker, at) {
  if (!Array.isArray(exchange?.optionSymbols) || !Array.isArray(ticker)) return [];
  const quoteBySymbol = new Map(ticker.filter(t => typeof t?.symbol === 'string')
    .map(t => [t.symbol, t]));
  const contracts = [];
  for (const item of exchange.optionSymbols) {
    if (!item || item.status !== 'TRADING' || item.quoteAsset !== 'USDT' ||
        item.underlying !== 'ETHUSDT' || !/^ETH-\d{6}-[\d.]+-[CP]$/.test(item.symbol || '') ||
        !positive(item.unit) || !(Number(item.expiryDate) > at + MIN_TIME_TO_EXPIRY_MS)) {
      continue;
    }
    const filter = Array.isArray(item.filters)
      ? item.filters.find(f => f.filterType === 'LOT_SIZE') ||
        item.filters.find(f => f.filterType === 'PRICE_FILTER') : null;
    const price = quoteBySymbol.get(item.symbol)?.askPrice;
    const bid = quoteBySymbol.get(item.symbol)?.bidPrice;
    const qty = filter?.minQty ?? item.minQty;
    if (!positive(price) || !positive(bid) || Number(bid) > Number(price) ||
        !positive(qty)) continue;
    try {
      requireOrderFilters(exchange, {
        symbol: item.symbol, price: String(price), quantity: String(qty),
      }, at, at + MAX_DEADLINE_MS);
      contracts.push({ symbol: item.symbol, expiry: Number(item.expiryDate) });
    } catch (_) {
      // Un precio/lot no negociable nunca se redondea ni se sustituye.
    }
  }
  return contracts.sort((a, b) => a.expiry - b.expiry);
}

async function assessPreflight({ client, at = Date.now(), env = process.env }) {
  const states = new Map();
  states.set('liveFlagsOff', env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false');
  let exchange, ticker;
  try { exchange = await client.getExchangeInfo(); } catch (_) { exchange = null; }
  const allEth = Array.isArray(exchange?.optionSymbols) && exchange.optionSymbols.some(item =>
    item?.status === 'TRADING' && item.underlying === 'ETHUSDT' &&
    item.quoteAsset === 'USDT' && Number(item.expiryDate) > at + MIN_TIME_TO_EXPIRY_MS);
  states.set('ethContracts', Boolean(allEth));
  const hasFilters = Array.isArray(exchange?.optionSymbols) &&
    exchange.optionSymbols.some(item => item?.underlying === 'ETHUSDT' &&
      Array.isArray(item.filters) && item.filters.some(f =>
        f.filterType === 'PRICE_FILTER' && positive(f.tickSize)));
  states.set('exchangeFilters', Boolean(hasFilters));
  try { ticker = await client.getTicker(); } catch (_) { ticker = null; }
  const lots = eligibleEthContracts(exchange, ticker, at);
  states.set('quotedLots', lots.length > 0);
  let depthOk = false;
  if (lots.length) {
    try { depthOk = Boolean(validBook(await client.getDepth(lots[0].symbol, 10))); }
    catch (_) { depthOk = false; }
  }
  states.set('depth', depthOk);

  let account;
  try { account = await client.getAccount(); } catch (_) { account = null; }
  states.set('accountReadable', Boolean(account && typeof account === 'object' &&
    !Array.isArray(account) && Array.isArray(account.asset)));

  let perms;
  try { perms = await client.getApiRestrictions(); } catch (_) { perms = null; }
  states.set('apiPermissions', Boolean(perms && perms.ipRestrict === true &&
    perms.enableWithdrawals === false && perms.enableReading === true &&
    perms.enableVanillaOptions === true));

  let positions, openOrders;
  try { positions = await client.getPositions(); } catch (_) { positions = null; }
  try { openOrders = await client.getOpenOrders(); } catch (_) { openOrders = null; }
  states.set('isolatedAccount', Boolean(accountIsolated(positions, openOrders)));

  return {
    readOnly: true,
    technicalStatus: [...states.values()].every(Boolean) ? 'pass' : 'fail',
    pilotReady: false,
    checks: [
      ...CHECK_NAMES.map(name => ({ name, status: states.get(name) ? 'pass' : 'fail' })),
      ...PENDING_NAMES.map(name => ({ name, status: 'unverified' })),
    ],
  };
}

function formatSanitized(result) {
  if (!result || result.readOnly !== true || result.pilotReady !== false ||
      !['pass', 'fail'].includes(result.technicalStatus) ||
      !Array.isArray(result.checks) || result.checks.length !== CHECK_NAMES.length + PENDING_NAMES.length ||
      result.checks.some((c, i) => c.name !== [...CHECK_NAMES, ...PENDING_NAMES][i] ||
        c.status !== (i < CHECK_NAMES.length ? 'pass' : 'unverified') &&
        c.status !== (i < CHECK_NAMES.length ? 'fail' : 'unverified'))) {
    throw new Error('Invalid preflight result');
  }
  return [
    ...result.checks.map(c => 'pilot_' + c.name + '=' + c.status),
    'pilot_technical_status=' + result.technicalStatus,
    'pilot_ready=no',
  ];
}

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid internal user ID');
  const client = await credentials.getClientForUser(id);
  const result = await assessPreflight({ client });
  for (const line of formatSanitized(result)) console.log(line);
  if (result.technicalStatus !== 'pass') process.exitCode = 2;
}

if (require.main === module) {
  main().catch(() => {
    // Nunca publicar error externo, identificadores ni respuestas firmadas.
    console.log('pilot_preflight=unavailable');
    process.exitCode = 1;
  });
}

module.exports = {
  assessPreflight, formatSanitized, eligibleEthContracts, accountIsolated,
  validBook, CHECK_NAMES, PENDING_NAMES,
};
