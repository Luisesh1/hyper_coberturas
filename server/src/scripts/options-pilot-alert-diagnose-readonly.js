/**
 * Sanitized read-only diagnostic for paused ETH pilot and its source binding.
 * No secrets, names, alert IDs, parameters' values or account figures.
 * Explicitly NOT an operational go-live preflight.
 */
'use strict';
const dbDefault=require('../db');
const { BOT_PARAMS,BOT_LIMITS,MARKER,paramsMatch }=
  require('./options-pilot-configure-paused');
const {BOT_MARKER:INDEPENDENT_MARKER}=
  require('./options-pilot-create-independent-paused');
const {NEW_PARAMS:INDEPENDENT_PARAMS}=
  require('./options-pilot-adjust-independent-budget-paused');
const { validateParams }=require('../services/options/templates/alert-signal');
const { strategyFits,globalFits }=require('./options-pilot-strategy-readiness');

const USER_ID=1;
const EXPECTED_PARAMS=validateParams(BOT_PARAMS);
const PARAM_KEYS=Object.keys(EXPECTED_PARAMS).filter(x=>x!=='alertIds').sort();
const LIMIT_KEYS=Object.keys(BOT_LIMITS).sort();

function safeObject(x) {
  if (x && typeof x==='object' && !Array.isArray(x)) return x;
  if (typeof x!=='string') return null;
  try {
    const value=JSON.parse(x);
    return value && typeof value==='object' && !Array.isArray(value) ? value:null;
  } catch {return null;}
}
function off(env) {
  return env.OPTIONS_LIVE_TRADING_ENABLED==='false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED==='false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED!=='true';
}
function compute({rows=[],limits=null,livePositions=[],orders=[]}={}) {
  // The original strategy can be user-customized. Once an independent pilot
  // exists, audit its approved configuration instead of comparing the source
  // with an obsolete blueprint. Duplicates never fall back to the source.
  const independent=rows.filter(s=>s?.name===INDEPENDENT_MARKER);
  const target=independent.length?'independent':'source';
  const expected=target==='independent'?INDEPENDENT_PARAMS:EXPECTED_PARAMS;
  const matches=target==='independent'?independent:
    rows.filter(s=>s?.name===MARKER);
  const s=matches.length===1?matches[0]:null;
  const params=safeObject(s?.params), ownLimits=safeObject(s?.limits);
  const pKeys=params?Object.keys(params).sort():[];
  const eKeys=Object.keys(EXPECTED_PARAMS).sort();
  const checks={
    singlePilotMarker:matches.length===1,
    strategyPaused:Boolean(s?.mode==='paused'),
    templateEth:Boolean(s?.template==='alert_signal' && s?.underlying==='ETH' &&
      Number(s.user_id)===USER_ID),
    paramShape:JSON.stringify(pKeys)===JSON.stringify(eKeys),
    alertBound:Array.isArray(params?.alertIds) && params.alertIds.length===1 &&
      Number.isSafeInteger(Number(params.alertIds[0])) && Number(params.alertIds[0])>0,
    ownLimitShape:Boolean(ownLimits) &&
      Object.keys(ownLimits).sort().join(',')===LIMIT_KEYS.join(','),
    globalRisk:globalFits(limits)===true,
    noLiveActivity:Array.isArray(livePositions) && livePositions.length===0 &&
      Array.isArray(orders) && orders.length===0 &&
      rows.every(row=>row.mode!=='live'),
    strategyFits:Boolean(s && params && ownLimits && strategyFits({
      id:Number(s.id),userId:USER_ID,name:s.name,underlying:s.underlying,
      template:s.template,mode:s.mode,params,limits:ownLimits,
    })),
  };
  for(const key of PARAM_KEYS)
    checks['param_'+key]=Boolean(params) &&
      JSON.stringify(params[key])===JSON.stringify(expected[key]);
  for(const key of LIMIT_KEYS)
    checks['limit_'+key]=Boolean(ownLimits) &&
      JSON.stringify(ownLimits[key])===JSON.stringify(BOT_LIMITS[key]);
  // Block if a future refactor drops fields or unexpectedly alters the schema.
  if (!paramsMatch({...expected,alertIds:[]},expected))
    throw new Error('Invalid expected pilot config');
  return {readOnly:true,pilotReady:false,target,checks};
}
const CHECKS=[
  'singlePilotMarker','strategyPaused','templateEth','paramShape',
  'alertBound','ownLimitShape','globalRisk','noLiveActivity','strategyFits',
  ...PARAM_KEYS.map(x=>'param_'+x),...LIMIT_KEYS.map(x=>'limit_'+x),
];
function lines(result) {
  if (result?.readOnly!==true || result?.pilotReady!==false ||
    !['source','independent'].includes(result.target) ||
    CHECKS.some(k=>typeof result.checks?.[k]!=='boolean') ||
    Object.keys(result.checks).length!==CHECKS.length) throw new Error('Invalid diagnostic');
  return [
    'pilot_alert_diag_read_only=yes',
    'pilot_alert_diag_target='+result.target,
    ...CHECKS.map(k=>'pilot_alert_diag_'+k+'='+
      (result.checks[k]?'pass':'fail')),
    'pilot_alert_diag_orders_sent=0',
    'pilot_ready=no',
  ];
}
async function diagnose({db=dbDefault,env=process.env}={}) {
  if (!off(env)) throw new Error('Trading must be OFF');
  const [{rows:strategies},{rows:settings},{rows:positions},{rows:orders}]=await Promise.all([
    db.query('SELECT * FROM options_strategies WHERE user_id=$1',[USER_ID]),
    db.query("SELECT value FROM settings WHERE user_id=$1 AND key='options_limits'",[USER_ID]),
    db.query("SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",[USER_ID]),
    db.query('SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',[USER_ID]),
  ]);
  return compute({rows:strategies,limits:safeObject(settings[0]?.value),
    livePositions:positions,orders});
}
async function main(){
  if(process.argv.length!==3 || process.argv[2]!=='--read-only')
    throw new Error('Explicit read-only argument required');
  lines(await diagnose()).forEach(x=>console.log(x));
}
if(require.main===module){
  main().catch(()=>{
    console.log('pilot_alert_diag_read_only=unavailable');
    console.log('pilot_alert_diag_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  }).finally(()=>dbDefault.pool.end());
}
module.exports={compute,lines,diagnose,CHECKS,EXPECTED_PARAMS};
