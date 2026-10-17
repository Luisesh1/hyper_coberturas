/**
 * Diagnóstico GTC de opciones ETH contra los filtros VIGENTES de Binance.
 * SOLO GET (exchangeInfo, positions, openOrders, apiRestrictions).
 * NUNCA POST/DELETE, cancelaciones, cambios de flags ni mutaciones de DB.
 * No demuestra que Binance liquide un residuo o que un TP parcial cierre.
 *
 * Uso desde el contenedor server con trading OFF:
 * node src/scripts/options-gtc-dust-readonly.js ETH-YYMMDD-STRIKE-C
 */
'use strict';

const { matchesStep } = require('../services/options/options-order-filters');
const { accountIsolated } = require('./options-pilot-preflight');

const SYMBOL_RE = /^ETH-\d{6}-\d+(?:\.\d+)?-C$/;
const ORIGINAL_QTY = '0.01';
const EXAMPLE_FILL = '0.005';
const EXAMPLE_REMAINING = '0.005';
const FLAGS = ['OPTIONS_LIVE_TRADING_ENABLED', 'OPTIONS_LIVE_PRODUCTION_APPROVED'];

function flagsAreOff(env) {
  return FLAGS.every(key => env[key] === 'false') &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
}

function validNewOrderQty(qty, filter, symbolInfo) {
  const min = Number(filter?.minQty);
  const step = Number(filter?.stepSize);
  const max = Number(filter?.maxQty ?? symbolInfo?.maxQty);
  const value = Number(qty);
  if (!(min > 0) || !(step > 0) || !(max > 0) ||
      !Number.isFinite(value) || value <= 0) return null;
  return value >= min && value <= max &&
    matchesStep(String(qty), filter.minQty, filter.stepSize);
}

function checkLot(exchange, symbol, now = Date.now()) {
  if (!SYMBOL_RE.test(symbol)) return null;
  const info = exchange?.optionSymbols?.find(item => item?.symbol === symbol);
  if (!info || info.status !== 'TRADING' || info.underlying !== 'ETHUSDT' ||
      info.quoteAsset !== 'USDT' || !(Number(info.expiryDate) > now)) return null;
  const filter = info.filters?.find(f => f.filterType === 'LOT_SIZE') ||
    info.filters?.find(f => f.filterType === 'PRICE_FILTER');
  const initialOrderValid = validNewOrderQty(ORIGINAL_QTY, filter, info);
  const residualNewOrderValid = validNewOrderQty(EXAMPLE_REMAINING, filter, info);
  if (initialOrderValid === null || residualNewOrderValid === null) return null;
  return { initialOrderValid, residualNewOrderValid,
    minQty: String(filter.minQty), stepSize: String(filter.stepSize) };
}

/**
 * Consulta de muestras públicas de trades: un único fill incompatible con
 * minQty/stepSize DEMUESTRA que el filtro de entrada no protege cada ejecución.
 * Cero anomalías en una muestra NO demuestra imposibilidad de fracciones.
 */
function assessTradeSample(trades, lot, symbol) {
  if (!Array.isArray(trades) || !lot) {
    return { tradeEvidenceStatus: 'unavailable', observedTrades: 0,
      observedOutOfLotTrades: 0 };
  }
  const valid = trades.every(t => t && t.symbol === symbol &&
    /^\d+(?:\.\d+)?$/.test(String(t.qty)) && Number(t.qty) > 0);
  if (!valid) {
    return { tradeEvidenceStatus: 'unavailable', observedTrades: 0,
      observedOutOfLotTrades: 0 };
  }
  const outOfLot = trades.filter(t =>
    Number(t.qty) < Number(lot.minQty) ||
    !matchesStep(String(t.qty), lot.minQty, lot.stepSize)
  ).length;
  return {
    tradeEvidenceStatus: outOfLot ? 'out_of_lot_observed' :
      trades.length ? 'lot_aligned_observed' : 'no_trades',
    observedTrades: trades.length, observedOutOfLotTrades: outOfLot,
  };
}

function blocked(flagsOff = false) {
  return {
    status: 'blocked', flagsOff, filtersChecked: false,
    accountIsolated: false, permissionsSafe: false,
    initialOrderValid: false, residualNewOrderValid: null,
    lotMinQty: null, lotStepSize: null,
    tradeEvidenceStatus: 'unavailable', observedTrades: 0,
    observedOutOfLotTrades: 0, readOnly: true, pilotReady: false,
  };
}

async function assess({ client, symbol, env = process.env, now = Date.now }) {
  if (!SYMBOL_RE.test(symbol || '') || !flagsAreOff(env)) return blocked(false);
  // signed GETs and public GETs only; no mutation methods are available to this script.
  const results = await Promise.allSettled([
    client.getExchangeInfo(), client.getPositions(),
    client.getOpenOrders(), client.getApiRestrictions(),
    client.getRecentTrades(symbol, 100),
  ]);
  const [exchange, positions, orders, restrictions, publicTrades] =
    results.map(r => r.status === 'fulfilled' ? r.value : null);
  const lot = checkLot(exchange, symbol, now());
  const sample = assessTradeSample(publicTrades, lot, symbol);
  const isolated = accountIsolated(positions, orders);
  const permissions = restrictions?.ipRestrict === true &&
    restrictions?.enableWithdrawals === false &&
    restrictions?.enableReading === true &&
    restrictions?.enableVanillaOptions === true;
  if (!lot || !lot.initialOrderValid || !isolated || !permissions) {
    return { ...blocked(true), filtersChecked: Boolean(lot),
      initialOrderValid: Boolean(lot?.initialOrderValid),
      residualNewOrderValid: lot?.residualNewOrderValid ?? null,
      lotMinQty: lot?.minQty ?? null, lotStepSize: lot?.stepSize ?? null,
      ...sample, accountIsolated: isolated, permissionsSafe: permissions };
  }
  return {
    // Nueva orden 0.005 invalida NO demuestra fill real de 0.005.
    // Solo una ejecucion publica fuera del lote aporta evidencia positiva.
    status: sample.tradeEvidenceStatus === 'out_of_lot_observed' ?
      'risk_detected' : 'filter_only',
    flagsOff: true, filtersChecked: true,
    accountIsolated: true, permissionsSafe: true,
    initialOrderValid: true, residualNewOrderValid: lot.residualNewOrderValid,
    lotMinQty: lot.minQty, lotStepSize: lot.stepSize, ...sample,
    readOnly: true, pilotReady: false,
  };
}

function summaryLines(report) {
  if (!report || report.readOnly !== true || report.pilotReady !== false ||
      !['blocked','risk_detected','filter_only'].includes(report.status) ||
      ['flagsOff','filtersChecked','accountIsolated','permissionsSafe',
        'initialOrderValid'].some(k => typeof report[k] !== 'boolean') ||
      ![true,false,null].includes(report.residualNewOrderValid) ||
      (report.status !== 'blocked' && (!report.flagsOff || !report.filtersChecked ||
        !report.accountIsolated || !report.permissionsSafe || !report.initialOrderValid))) {
    throw new Error('Invalid GTC diagnostic');
  }
  const check = v => v ? 'pass' : 'fail';
  return [
    'gtc_dust_read_only=yes',
    'gtc_dust_status=' + report.status,
    'gtc_dust_flags_off=' + check(report.flagsOff),
    'gtc_dust_account_isolated=' + check(report.accountIsolated),
    'gtc_dust_permissions_safe=' + check(report.permissionsSafe),
    'gtc_dust_exchange_filters=' + check(report.filtersChecked),
    'gtc_dust_initial_qty=' + ORIGINAL_QTY,
    'gtc_dust_example_fill=' + EXAMPLE_FILL,
    'gtc_dust_example_remaining=' + EXAMPLE_REMAINING,
    'gtc_dust_initial_order_filter=' + check(report.initialOrderValid),
    'gtc_dust_new_residual_order_filter=' +
      (report.residualNewOrderValid === null ? 'unverified' :
        check(report.residualNewOrderValid)),
    'gtc_dust_public_trades_status=' + report.tradeEvidenceStatus,
    'gtc_dust_public_trades_sample_count=' + report.observedTrades,
    'gtc_dust_public_trades_out_of_lot=' + report.observedOutOfLotTrades,
    'gtc_dust_existing_gtc_partial_behavior=unverified',
    'gtc_dust_actual_residual_liquidation=unverified',
    'gtc_dust_real_orders_sent=0',
    'pilot_ready=no',
  ];
}

async function main() {
  const symbol = process.argv[2];
  if (!SYMBOL_RE.test(symbol || '') || process.argv.length !== 3) {
    throw new Error('Invalid ETH call option symbol');
  }
  // Fail closed BEFORE connecting to Binance if any live flag is ON.
  if (!flagsAreOff(process.env)) {
    for (const line of summaryLines(blocked(false))) console.log(line);
    process.exitCode = 2;
    return;
  }
  const credentials = require('../services/options/options-credentials.service');
  const client = await credentials.getClientForUser(1);
  const result = await assess({ client, symbol });
  for (const line of summaryLines(result)) console.log(line);
  if (result.status === 'blocked') process.exitCode = 2;
}

if (require.main === module) {
  main().catch(() => {
    console.log('gtc_dust_status=unavailable');
    console.log('pilot_ready=no');
    process.exitCode = 1;
  });
}

module.exports = { flagsAreOff, validNewOrderQty, checkLot,
  assessTradeSample, assess, summaryLines };
