/**
 * Inspección de estrategias del piloto. SOLO lectura de PostgreSQL y límites.
 * No crea, actualiza, pausa, activa ni ejecuta bots u órdenes.
 * No convierte la autorización de preparar en autorización de trading.
 */
const repoDefault=require('../repositories/options-strategies.repository');
const credsDefault=require('../services/options/options-credentials.service');
const { validateParams }=require('../services/options/templates/alert-signal');

const USER_ID=1;
const MAX_ENTRY_USDT=0.26;
const MAX_TOTAL_USDT=20;
// Solo el piloto ETH independiente autorizado admite 0.36 prima / 0.40
// capital. Los demás bots conservan el perfil estricto anterior.
const INDEPENDENT_MARKER='PILOTO ETH 7-14 - independiente - PAUSADO';
const INDEPENDENT_PREMIUM=0.36;
const INDEPENDENT_CAPITAL=0.40;
const allowed=(x,a,b)=>Number.isFinite(Number(x))&&Number(x)>=a&&Number(x)<=b;

function strategyFits(s) {
  if (!s || s.userId!==USER_ID || s.underlying!=='ETH' ||
      s.template!=='alert_signal' || !['paused','shadow'].includes(s.mode))
    return false;
  let p;
  try { p=validateParams(s.params); } catch (_) { return false; }
  const l=s.limits || {};
  const oldBudget=allowed(p.maxPremiumUsdt,0.01,MAX_ENTRY_USDT) &&
    allowed(p.capitalUsdt,MAX_ENTRY_USDT,MAX_ENTRY_USDT);
  // Admisible SOLO para la nueva estrategia independiente pausada,
  // vinculada a UNA alerta. No aumenta presupuestos de terceros.
  const newBudget=s.name===INDEPENDENT_MARKER &&
    s.mode==='paused' &&
    p.maxPremiumUsdt===INDEPENDENT_PREMIUM &&
    p.capitalUsdt===INDEPENDENT_CAPITAL &&
    p.structure==='buy_with' && p.targetDelta===0.35 &&
    p.takeProfitMode==='fixed' && p.takeProfitPct===50 &&
    p.stopLossPct===50 && p.expiryDays===7 &&
    Array.isArray(p.alertIds) && p.alertIds.length===1 &&
    l.maxOrdersPerDay===3 &&
    allowed(l.maxDailyLossUsdt,0,1) &&
    allowed(l.maxMarginUsdt,0,1);
  return (oldBudget||newBudget) && p.structure==='buy_with' &&
    p.contractCount===1 && p.quantity===0.01 &&
    p.maxOpenPositions===1 && p.maxTradesPerDay===1 &&
    p.onOpposite==='close' &&
    p.takeProfitMode==='fixed' &&
    allowed(p.takeProfitPct,1,100) &&
    allowed(p.stopLossPct,1,50) &&
    allowed(p.exitHoursBeforeExpiry,12,72) &&
    allowed(l.maxOrdersPerDay,1,3) &&
    allowed(l.maxDailyLossUsdt,0,MAX_TOTAL_USDT) &&
    allowed(l.maxMarginUsdt,0,MAX_TOTAL_USDT);
}

function globalFits(l) {
  return l && allowed(l.maxDailyLossUsdt,0,MAX_TOTAL_USDT) &&
    allowed(l.maxMarginUsdt,0,MAX_TOTAL_USDT) &&
    l.maxLiveStrategies===1 && l.notifyTelegram===true;
}

async function inspect({
  repo=repoDefault,credentials=credsDefault,userId=USER_ID,
}) {
  if(userId!==USER_ID)throw new Error('Unexpected pilot user ID');
  const [strategies,globalLimits,livePositions]=await Promise.all([
    repo.listStrategies(userId),
    credentials.getLimits(userId),
    repo.listOpenPositionsByUser(userId,'live'),
  ]);
  if(!Array.isArray(strategies)||!Array.isArray(livePositions))
    throw new Error('Unable to inspect complete pilot state');
  const noActiveLive=strategies.every(s=>s.mode!=='live');
  const noPositions=livePositions.length===0;
  const matches=strategies.filter(strategyFits);
  const checks={
    accountStrategiesKnown:true,
    noActiveLiveStrategies:noActiveLive,
    noLivePositions:noPositions,
    globalRiskRestricted:globalFits(globalLimits),
    exactStrategyAvailable:matches.length===1,
  };
  const technicalPass=Object.values(checks).every(Boolean);
  // A paused alert strategy with alertIds: [] is only a safe blueprint:
  // it cannot produce the first entry from an alert. Do not label it
  // operationally ready without showing this missing prerequisite.
  const entrySignalConfigured=technicalPass &&
    Array.isArray(matches[0].params?.alertIds) &&
    matches[0].params.alertIds.length>0;
  return {
    readOnly:true,
    pilotReady:false,
    entrySignalConfigured,
    status:technicalPass?'strategy_candidate':'strategy_not_ready',
    checks,
    strategyCount:strategies.length,
    // Solo IDs internos de estrategias que cumplieron los criterios.
    // Un candidato no implica que una señal produzca el contrato elegido.
    candidateStrategyId:technicalPass?matches[0].id:null,
  };
}

function safeLines(r) {
  const keys=['accountStrategiesKnown','noActiveLiveStrategies',
    'noLivePositions','globalRiskRestricted','exactStrategyAvailable'];
  if(r?.readOnly!==true||r.pilotReady!==false||
    typeof r.entrySignalConfigured!=='boolean' ||
    !['strategy_candidate','strategy_not_ready'].includes(r.status) ||
    !Number.isSafeInteger(r.strategyCount)||r.strategyCount<0 ||
    keys.some(k=>typeof r.checks?.[k]!=='boolean') ||
    (r.status==='strategy_candidate'&&
      (!Number.isSafeInteger(r.candidateStrategyId)||r.candidateStrategyId<=0)) ||
    (r.status==='strategy_not_ready' && r.candidateStrategyId!==null)) {
    throw new Error('Invalid strategy inspection output');
  }
  return [
    'strategy_preview_status='+r.status,
    'strategy_preview_count='+r.strategyCount,
    ...keys.map(k=>'strategy_preview_'+k+'='+(r.checks[k]?'pass':'fail')),
    'strategy_preview_candidate_id='+(r.candidateStrategyId??'unverified'),
    'strategy_preview_entry_signal_configured='+(r.entrySignalConfigured?'yes':'no'),
    'strategy_preview_exact_contract_generated=unverified',
    'strategy_preview_execution_approved=no',
    'pilot_ready=no',
  ];
}

async function main(){
  const result=await inspect({});
  for(const line of safeLines(result))console.log(line);
}
if(require.main===module){
  main().catch(()=>{
    console.log('strategy_preview_status=unavailable');
    process.exitCode=1;
  });
}
module.exports={strategyFits,globalFits,inspect,safeLines,USER_ID};
