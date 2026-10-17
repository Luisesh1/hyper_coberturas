/**
 * Vista previa de UNA posible entrada ETH LIMIT BUY, sin enviar órdenes.
 * Los parámetros son indicativos, NO una autorización del usuario.
 *
 * Lee: exchangeInfo, ticker, depth, marginAccount, posiciones,
 * openOrders, apiRestrictions (GET). No POST/DELETE ni escrituras en DB.
 * Nunca muestra saldos, claves, direcciones, historial o ID interno.
 *
 * Disponible != patrimonio: OPTIONS expone available, no equity.
 */
const credentials = require('../services/options/options-credentials.service');
const { requireOrderFilters } = require('../services/options/options-order-filters');
const { accountIsolated } = require('./options-pilot-preflight');

const CAP_USDT = 20;
const ENTRY_FEE_BOUND = 0.10;
const MAX_SPREAD = 0.10;
const MIN_EXPIRY_MS = 3 * 86400_000;
const MAX_BOOK_AGE_MS = 10_000;
const APPROVED_PATTERN = /^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/;
const validPos = v => v !== null && v !== undefined && v !== '' &&
  Number.isFinite(Number(v)) && Number(v) > 0;

function parseInputs(argv) {
  const [rawUserId, symbol, quantity, maxLimit] = argv;
  const id = Number(rawUserId);
  if (!/^[1-9]\d{0,14}$/.test(String(rawUserId || '')) ||
      !Number.isSafeInteger(id) || !APPROVED_PATTERN.test(symbol || '') ||
      !/^\d+(?:\.\d{1,12})?$/.test(String(quantity ?? '')) ||
      !/^\d+(?:\.\d{1,12})?$/.test(String(maxLimit ?? '')) ||
      !validPos(quantity) || !validPos(maxLimit)) {
    throw new Error('Invalid preview request');
  }
  if (Number(quantity) * Number(maxLimit) * (1 + ENTRY_FEE_BOUND) > CAP_USDT) {
    throw new Error('Preview cost exceeds conservative cap');
  }
  return { userId: id, symbol, quantity: String(quantity), maxLimit: String(maxLimit) };
}

function bestBook(book, qty, maxLimit) {
  if (!book || !Array.isArray(book.asks) || !Array.isArray(book.bids) ||
      !validPos(qty) || !validPos(maxLimit)) return null;
  const levels = rows => rows.filter(x => Array.isArray(x) && validPos(x[0]) && validPos(x[1]))
    .map(x => ({ price: Number(x[0]), qty: Number(x[1]) }));
  const asks = levels(book.asks).sort((a,b) => a.price - b.price);
  const bids = levels(book.bids).sort((a,b) => b.price - a.price);
  if (!asks.length || !bids.length || asks[0].price <= bids[0].price ||
      asks[0].price > maxLimit ||
      (asks[0].price - bids[0].price) / asks[0].price > MAX_SPREAD) return null;
  // FOK needs the entire quantity within the maximum LIMIT, not just
  // the quantity displayed at the best ask (or best bid for exitability).
  const covers = (levels, allowed) => {
    let remaining=Number(qty), worst=null;
    for (const level of levels) {
      if (!allowed(level.price)) break;
      remaining-=level.qty;
      worst=level.price;
      if (remaining <= 1e-10) return worst;
    }
    return null;
  };
  const worstAsk=covers(asks, price => price <= maxLimit + 1e-9);
  const worstBid=covers(bids, price =>
    (asks[0].price - price)/asks[0].price <= MAX_SPREAD + 1e-9);
  if (worstAsk == null || worstBid == null) return null;
  return { ask: asks[0].price, bid: bids[0].price,
    worstAsk, worstBid,
    spreadFraction: (asks[0].price - bids[0].price) / asks[0].price };
}

function availableUsdt(account) {
  if (!account || !Array.isArray(account.asset)) return null;
  const row=account.asset.find(x => x && x.asset === 'USDT');
  // Binance OPTIONS marginAccount devuelve available, no
  // availableBalance (campo de Futures). Nunca derivar capital libre
  // de equity, marginBalance ni walletBalance.
  if (!row || row.available === undefined || row.available === null ||
      row.available === '' ||
      !Number.isFinite(Number(row.available)) || Number(row.available) < 0) return null;
  return Number(row.available);
}

function roundupCents(number) {
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.ceil((number - 1e-10) * 100) / 100;
}

async function preview({ client, input, at = Date.now(), now = Date.now, env = process.env }) {
  const { symbol, quantity, maxLimit } = input;
  const qty=Number(quantity), max=Number(maxLimit);
  const premiumMax=qty * max;
  const feeBound=premiumMax * ENTRY_FEE_BOUND;
  const maxEntry=roundupCents(premiumMax + feeBound);
  if (!validPos(qty) || !validPos(max) || !(maxEntry <= CAP_USDT)) {
    throw new Error('Invalid capped premium');
  }

  const states = {};
  states.flagsOff = env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false';

  let exchange, quote, book, account, positions, openOrders, perms;
  try { exchange=await client.getExchangeInfo(); } catch (_) { exchange=null; }
  const meta = exchange?.optionSymbols?.find(o => o.symbol === symbol);
  states.listed = Boolean(meta && meta.status === 'TRADING' &&
    meta.underlying === 'ETHUSDT' && meta.quoteAsset === 'USDT' &&
    validPos(meta.unit) && Number(meta.expiryDate) > at + MIN_EXPIRY_MS);
  try { quote=await client.getTicker(symbol); } catch (_) { quote=null; }
  if (Array.isArray(quote)) quote=quote.find(x => x.symbol === symbol) || null;
  states.marketQuotePresent=Boolean(quote && quote.symbol === symbol &&
    validPos(quote.askPrice) && validPos(quote.bidPrice) &&
    Number(quote.bidPrice) <= Number(quote.askPrice));
  states.priceWithinLimit=states.marketQuotePresent &&
    Number(quote.askPrice) <= max + 1e-9;
  states.quoteValid=states.marketQuotePresent && states.priceWithinLimit;
  try {
    if (states.listed && states.marketQuotePresent) {
      requireOrderFilters(exchange, { symbol, price:String(quote.askPrice),
        quantity }, at, at+10*60000);
      // Validate the exact approved price independently of market movement;
      // a stale limit is not a filter failure.
      requireOrderFilters(exchange, { symbol, price:maxLimit, quantity },
        at, at+10*60000);
      states.exactFilters=true;
    } else states.exactFilters=false;
  } catch (_) { states.exactFilters=false; }

  try { book=await client.getDepth(symbol,20); } catch (_) { book=null; }
  const depthReceivedAt=now();
  const depthAt=Number(book?.T);
  states.bookFresh=book?.T != null && Number.isSafeInteger(depthAt) &&
    depthAt <= depthReceivedAt + 1000 &&
    depthAt >= depthReceivedAt - MAX_BOOK_AGE_MS;
  const top=states.bookFresh ? bestBook(book,qty,max) : null;
  states.liquidity=Boolean(top && states.quoteValid &&
    top.ask <= Number(quote.askPrice) + 1e-9);

  try { account=await client.getAccount(); } catch (_) { account=null; }
  const available=availableUsdt(account);
  states.balanceKnown=available !== null;
  states.balanceEnough=available === null ? null : available >= maxEntry;

  try { perms=await client.getApiRestrictions(); } catch (_) { perms=null; }
  states.permissions=Boolean(perms && perms.ipRestrict === true &&
    perms.enableWithdrawals === false && perms.enableReading === true &&
    perms.enableVanillaOptions === true);

  try { positions=await client.getPositions(); } catch (_) { positions=null; }
  try { openOrders=await client.getOpenOrders(); } catch (_) { openOrders=null; }
  states.isolated=accountIsolated(positions,openOrders);

  const technicalPass=['flagsOff','listed','quoteValid','exactFilters',
    'liquidity','permissions','isolated'].every(k=>states[k]===true);
  const eligible=technicalPass && states.balanceEnough === true;
  return {
    readOnly:true,
    pilotReady:false,
    technicalStatus:!technicalPass ? 'blocked'
      : states.balanceKnown === false ? 'unverified'
        : states.balanceEnough === false ? 'blocked' : 'pass',
    eligible,
    publicOrder:{
      symbol, quantity, limitPrice:maxLimit,
      bid:states.marketQuotePresent ? String(quote.bidPrice) : null,
      ask:states.marketQuotePresent ? String(quote.askPrice) : null,
      expiry:states.listed ? new Date(Number(meta.expiryDate)).toISOString() : null,
      reason:!states.marketQuotePresent ? 'quote_unavailable'
        : !states.priceWithinLimit ? 'ask_above_limit'
          : !states.bookFresh ? 'depth_missing_or_stale'
            : !states.liquidity ? 'depth_insufficient' : 'quote_checked',
    },
    entryPremiumCapUsdt:roundupCents(premiumMax),
    entryFeeReserveUsdt:roundupCents(feeBound),
    entryTotalCapUsdt:maxEntry,
    checks:states,
    reviewedAt:at,
  };
}

const CHECKS=['flagsOff','listed','marketQuotePresent','priceWithinLimit',
  'quoteValid','exactFilters','bookFresh','liquidity',
  'balanceKnown','balanceEnough','permissions','isolated'];
const PUBLIC_REASONS=['quote_unavailable','ask_above_limit',
  'depth_missing_or_stale','depth_insufficient','quote_checked'];

function outputLines(r) {
  if (!r || r.readOnly!==true || r.pilotReady!==false ||
      !['pass','blocked','unverified'].includes(r.technicalStatus) ||
      !Number.isFinite(r.reviewedAt) ||
      !r.publicOrder || !APPROVED_PATTERN.test(r.publicOrder.symbol || '') ||
      !PUBLIC_REASONS.includes(r.publicOrder.reason) ||
      !validPos(r.publicOrder.quantity) || !validPos(r.publicOrder.limitPrice) ||
      !validPos(r.entryTotalCapUsdt) || r.entryTotalCapUsdt > CAP_USDT ||
      !r.checks || CHECKS.some(k => ![true,false,null].includes(r.checks[k]))) {
    throw new Error('Unsafe preview output');
  }
  const pub=r.publicOrder;
  // Los datos públicos del contrato sí pueden mostrarse; nunca valores
  // monetarios privados de la cuenta ni IDs internos ni keys.
  return [
    'preview_status='+r.technicalStatus,
    'preview_symbol='+pub.symbol,
    'preview_side=BUY',
    'preview_quantity='+pub.quantity,
    'preview_limit_usdt='+pub.limitPrice,
    'preview_bid_usdt='+(pub.bid ?? 'unverified'),
    'preview_ask_usdt='+(pub.ask ?? 'unverified'),
    'preview_market_reason='+pub.reason,
    'preview_expiry='+(pub.expiry ?? 'unverified'),
    'preview_premium_cap_usdt='+r.entryPremiumCapUsdt.toFixed(2),
    'preview_entry_fee_reserve_usdt='+r.entryFeeReserveUsdt.toFixed(2),
    'preview_entry_total_cap_usdt='+r.entryTotalCapUsdt.toFixed(2),
    ...CHECKS.map(k=>'preview_'+k+'='+(r.checks[k]===null?'unverified':
      r.checks[k] ? 'pass' : 'fail')),
    'preview_effective_fee_tier=unverified',
    'preview_usd_conversion=unverified',
    'preview_strategy_verified=unverified',
    'preview_operator_authorization=unverified',
    'pilot_ready=no',
  ];
}

async function main() {
  const input=parseInputs(process.argv.slice(2));
  const client=await credentials.getClientForUser(input.userId);
  const result=await preview({client,input});
  for (const line of outputLines(result)) console.log(line);
  // Un resultado blocked es diagnóstico, no error de workflow;
  // pero no se convierte en permiso de operación.
}

if (require.main===module) {
  main().catch(() => {
    console.log('preview_status=unavailable');
    process.exitCode=1;
  });
}
module.exports={parseInputs,bestBook,availableUsdt,preview,outputLines,CAP_USDT,MAX_BOOK_AGE_MS};
