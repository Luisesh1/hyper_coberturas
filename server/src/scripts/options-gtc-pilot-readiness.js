/**
 * Binance ETH options GTC pilot: final READ-ONLY preparation check.
 * Does NOT authorize a pilot, change a strategy, place/cancel an order,
 * or set production flags. No POST is reachable from this module.
 *
 * Usage in server container while both live flags are OFF:
 * node src/scripts/options-gtc-pilot-readiness.js 1 ETH-YYMMDD-STRIKE-C 0.01 MAX_LIMIT
 *
 * Price is supplied by the operator for a new, independent preview; this
 * command never chooses a new contract or raises the saved risk budget.
 */
const { parseInputs, preview } = require('./options-exact-buy-readonly-preview');
const { inspect } = require('./options-pilot-strategy-readiness');
const { BOT_PARAMS } = require('./options-pilot-configure-paused');
const { orderTimeInForce } =
  require('../services/options/options-live-execution.service');

const CONSERVATIVE_FEE_BOUND = 0.10;
const EXPECTED_QUANTITY = 0.01;

function checkPolicy({ input, quote, strategy, env }) {
  const maxPrice = Number(input?.maxLimit);
  const qty = Number(input?.quantity);
  const gross = maxPrice * qty;
  const total = gross * (1 + CONSERVATIVE_FEE_BOUND);
  const paused = strategy?.readOnly === true && strategy?.pilotReady === false &&
    strategy?.status === 'strategy_candidate' &&
    Number.isSafeInteger(strategy?.candidateStrategyId) &&
    strategy?.candidateStrategyId > 0;
  const liveOff = env?.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env?.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false' &&
    env?.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
  const exactSize = input?.userId === 1 && qty === EXPECTED_QUANTITY;
  const riskBudget = Number.isFinite(gross) && Number.isFinite(total) &&
    gross > 0 && gross <= BOT_PARAMS.maxPremiumUsdt + 1e-9 &&
    total <= BOT_PARAMS.capitalUsdt + 1e-9;
  const exchangeGtc = orderTimeInForce({
    symbol: input?.symbol, action: 'close', purpose: 'take_profit',
  }) === 'GTC';
  const ethFokEntry = orderTimeInForce({
    symbol: input?.symbol, action: 'open', purpose: 'standard',
  }) === 'FOK';
  const priceValidated = quote?.readOnly === true &&
    quote?.pilotReady === false &&
    quote?.eligible === true &&
    quote?.technicalStatus === 'pass' &&
    quote?.publicOrder?.symbol === input?.symbol &&
    Number(quote?.publicOrder?.quantity) === qty &&
    quote?.publicOrder?.limitPrice === input?.maxLimit;
  return {
    liveOff, paused, exactSize, riskBudget, exchangeGtc, ethFokEntry,
    priceValidated,
  };
}

function summaryLines(result) {
  const expected = ['liveOff','paused','exactSize','riskBudget',
    'exchangeGtc','ethFokEntry','priceValidated'];
  if (!result || result.readOnly !== true || result.pilotReady !== false ||
      !['candidate','blocked'].includes(result.status) ||
      expected.some(name => typeof result.checks?.[name] !== 'boolean') ||
      result.status !== (expected.every(k=>result.checks[k]) ? 'candidate' : 'blocked')) {
    throw new Error('Unsafe GTC pilot readiness result');
  }
  return [
    'gtc_pilot_read_only=yes',
    'gtc_pilot_entry_tif=FOK',
    'gtc_pilot_take_profit_tif=GTC',
    'gtc_pilot_take_profit_placement=after_confirmed_fill',
    ...expected.map(k => 'gtc_pilot_'+k+'='+
      (result.checks[k] ? 'pass' : 'fail')),
    'gtc_pilot_status='+result.status,
    'gtc_pilot_effective_fees=unverified',
    'gtc_pilot_partial_fill_dust_resolution=unverified',
    'gtc_pilot_real_post_and_exit=unverified',
    'gtc_pilot_operator_authorization=unverified',
    'pilot_ready=no',
  ];
}

async function assess({ input, client, env = process.env, now = Date.now,
  previewFn = preview, inspectFn = inspect }) {
  // Never even initiate Binance GETs when the order controls are ON:
  // this is a preparation utility, NOT an execution action.
  if (env.OPTIONS_LIVE_TRADING_ENABLED !== 'false' ||
      env.OPTIONS_LIVE_PRODUCTION_APPROVED !== 'false' ||
      env.OPTIONS_LIVE_PILOT_AUTHORIZED === 'true') {
    return { readOnly:true, pilotReady:false, status:'blocked',
      checks:checkPolicy({input,env,quote:null,strategy:null}) };
  }
  if (!input || input.userId !== 1 || Number(input.quantity) !== EXPECTED_QUANTITY) {
    return { readOnly:true, pilotReady:false, status:'blocked',
      checks:checkPolicy({input,env,quote:null,strategy:null}) };
  }
  const strategy = await inspectFn({userId:input.userId});
  // Do not query market data for an account without the exact paused strategy.
  const quote = strategy?.status === 'strategy_candidate'
    ? await previewFn({client,input,at:now(),now,env}) : null;
  const checks = checkPolicy({input,quote,strategy,env});
  return { readOnly:true,pilotReady:false,
    status:Object.values(checks).every(Boolean) ? 'candidate' : 'blocked',
    checks };
}

async function main() {
  const input = parseInputs(process.argv.slice(2));
  if (input.userId !== 1 || Number(input.quantity) !== EXPECTED_QUANTITY) {
    throw new Error('Not the single authorized pilot size');
  }
  const { getClientForUser } =
    require('../services/options/options-credentials.service');
  const client = await getClientForUser(input.userId);
  const result = await assess({input,client});
  for (const line of summaryLines(result)) console.log(line);
  // A 'candidate' is NOT approval: actual fees, partial fill dust and
  // native Binance fills still block any production go-live.
}

if (require.main === module) {
  main().catch(() => {
    console.log('gtc_pilot_status=unavailable');
    console.log('pilot_ready=no');
    process.exitCode = 1;
  });
}

module.exports = { checkPolicy, summaryLines, assess };
