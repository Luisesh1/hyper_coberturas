/**
 * Barrera final de UNA apertura real ETH, nunca una autorización implícita.
 *
 * La condición env solo se utiliza cuando AMBOS flags de trading real están
 * activos. Sin los términos explícitos (usuario, estrategia, contrato,
 * cantidad, precio máximo, expiración y confirmación), no hay POST.
 *
 * No recomendar opciones por el precio más bajo: compra limitada al contrato
 * y condiciones que el operador haya revisado y autorizado por separado.
 */
const COST_CAP_USDT = 20;  // Límite prudente, no equivale a 100 USD.
const TRADE_FEE_CAP = 0.10; // Reserva 10 % del valor de opción, Binance FAQ.
const MAX_AUTH_LIFETIME_MS = 15 * 60_000;

function integer(value) {
  if (!/^[1-9]\d{0,14}$/.test(String(value ?? ''))) return null;
  const n=Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function decimal(value) {
  const valueText=String(value ?? '');
  if (!/^\d+(?:\.\d{1,12})?$/.test(valueText)) return null;
  const n=Number(valueText);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function loadPermit(env, at) {
  if (env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true') {
    throw new Error('Live pilot needs a separately authorized, exact one-order permit');
  }
  const userId=integer(env.OPTIONS_LIVE_PILOT_USER_ID);
  const strategyId=integer(env.OPTIONS_LIVE_PILOT_STRATEGY_ID);
  const symbol=env.OPTIONS_LIVE_PILOT_SYMBOL;
  const qty=decimal(env.OPTIONS_LIVE_PILOT_QUANTITY);
  const maxPrice=decimal(env.OPTIONS_LIVE_PILOT_MAX_PRICE);
  const expiresAt=Number(env.OPTIONS_LIVE_PILOT_EXPIRES_AT_MS);
  if (!userId || !strategyId || !/^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(symbol || '') ||
      !qty || !maxPrice || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= at || expiresAt > at + MAX_AUTH_LIFETIME_MS) {
    throw new Error('Live pilot permit is absent, expired or invalid');
  }
  if (!Number.isFinite(qty * maxPrice) ||
      Math.ceil(qty * maxPrice * (1 + TRADE_FEE_CAP) * 100) / 100 > COST_CAP_USDT) {
    throw new Error('Live pilot quote exceeds conservative 20 USDT entry cost cap');
  }
  return { userId, strategyId, symbol, qty, maxPrice, expiresAt };
}

function enforcePilotEntry({ strategy, action, env=process.env, now=Date.now() }) {
  // Para pruebas unitarias que inyectan enabled:true sin activar flags globales,
  // conservar la lógica simulada. En producción real la doble llave se exige
  // en el constructor del motor de ejecución, y este guard es obligatorio.
  if (env.OPTIONS_LIVE_TRADING_ENABLED !== 'true' &&
      env.OPTIONS_LIVE_PRODUCTION_APPROVED !== 'true') return;
  if (env.OPTIONS_LIVE_TRADING_ENABLED !== 'true' ||
      env.OPTIONS_LIVE_PRODUCTION_APPROVED !== 'true') {
    throw new Error('Both live trading flags required');
  }
  if (action.type !== 'open') return; // Nunca bloquear salidas protectoras.
  const permit=loadPermit(env, now);
  if (Number(strategy.userId)!==permit.userId ||
      Number(strategy.id)!==permit.strategyId ||
      String(strategy.underlying).toUpperCase() !== 'ETH' ||
      !Array.isArray(action.legs) || action.legs.length !== 1) {
    throw new Error('Pilot entry must be one approved ETH leg for one exact strategy');
  }
  const leg=action.legs[0];
  if (leg.side!=='BUY' || leg.symbol!==permit.symbol ||
      decimal(leg.quantity)===null || decimal(leg.price)===null ||
      Number(leg.quantity)!==permit.qty || Number(leg.price)>permit.maxPrice) {
    throw new Error('Pilot order does not match explicitly authorized BUY limit');
  }
  const worstEntry=Math.ceil((Number(leg.quantity) * Number(leg.price) *
    (1 + TRADE_FEE_CAP) - 1e-10) * 100) / 100;
  if (!Number.isFinite(worstEntry) || worstEntry > COST_CAP_USDT) {
    throw new Error('Pilot entry cost cap breached');
  }
}

module.exports={ COST_CAP_USDT, TRADE_FEE_CAP, MAX_AUTH_LIFETIME_MS,
  loadPermit, enforcePilotEntry };
