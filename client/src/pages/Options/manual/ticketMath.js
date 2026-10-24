// Cálculos del ticket de orden, hechos en el cliente a partir de la pata
// seleccionada de la cadena. Puros para poder probarlos sin DOM.

// Comisión de Binance Opciones: mín(0,03 % del nocional del subyacente,
// 10 % de la prima).
export const FEE_NOTIONAL_RATE = 0.0003;
export const FEE_PREMIUM_CAP = 0.1;

export const QTY_STEP = 0.01;
export const QTY_MIN = 0.01;

// Paso de precio del stepper según la magnitud de la prima:
// 1180 → 10, 62,4 → 0,1, 0,0123 → 0,0001.
export function priceStep(price) {
  const n = Math.abs(Number(price));
  if (!Number.isFinite(n) || n === 0) return 0.0001;
  const step = 10 ** (Math.floor(Math.log10(n)) - 2);
  return Math.max(0.0001, Number(step.toPrecision(1)));
}

// Rejilla de precios del contrato según su PRICE_FILTER de Binance:
// precio válido = minPrice + k·tickSize. Se opera en enteros escalados para
// no arrastrar errores de coma flotante (548 con tick 5 → 545/550).
function decimalsOf(n) {
  const text = String(n);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function priceGrid(leg) {
  const tick = Number(leg?.tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return null;
  const minRaw = Number(leg?.minPrice);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 0;
  const maxRaw = Number(leg?.maxPrice);
  const scale = 10 ** Math.max(decimalsOf(tick), decimalsOf(min));
  return {
    tick, min, max: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null, scale,
    t: Math.round(tick * scale), m: Math.round(min * scale),
  };
}

// Ajusta el precio a la rejilla del contrato: 'nearest', 'down' o 'up'.
// Sin tickSize conocido devuelve el precio tal cual.
export function snapToTick(price, leg, mode = 'nearest') {
  const grid = priceGrid(leg);
  const p = Number(price);
  if (!grid || !Number.isFinite(p)) return p;
  const round = mode === 'down' ? Math.floor : mode === 'up' ? Math.ceil : Math.round;
  const k = round((Math.round(p * grid.scale) - grid.m) / grid.t);
  return (grid.m + k * grid.t) / grid.scale;
}

// Un paso del stepper sobre la rejilla, sin bajar del mínimo del contrato.
export function stepOnTick(price, leg, direction) {
  const grid = priceGrid(leg);
  const base = snapToTick(price, leg, direction > 0 ? 'down' : 'up');
  const next = Number(((base * grid.scale + direction * grid.t) / grid.scale).toFixed(10));
  return Math.max(next, grid.min || grid.tick);
}

// Mensaje si el precio no cumple el PRICE_FILTER del contrato; null si vale.
export function tickError(price, leg) {
  const grid = priceGrid(leg);
  const p = Number(price);
  if (!grid || !Number.isFinite(p) || p <= 0) return null;
  if (grid.min > 0 && p < grid.min) return `Precio mínimo del contrato: ${grid.min} USDT.`;
  if (grid.max != null && p > grid.max) return `Precio máximo del contrato: ${grid.max} USDT.`;
  if (snapToTick(p, leg) === p) return null;
  return `Múltiplos de ${grid.tick} USDT: prueba ${snapToTick(p, leg, 'down')} o ${snapToTick(p, leg, 'up')}.`;
}

export function hasTick(leg) {
  return priceGrid(leg) != null;
}

// Paso de cantidad del stepper: décimas a partir de 0,1 contratos y
// centésimas por debajo (el mínimo de Binance es 0,01).
export const QTY_COARSE_STEP = 0.1;
export function qtyStep(qty, direction = 1) {
  const q = Number(qty);
  if (direction < 0) return q > QTY_COARSE_STEP ? QTY_COARSE_STEP : QTY_STEP;
  return q >= QTY_COARSE_STEP ? QTY_COARSE_STEP : QTY_STEP;
}

// Prima en USD → contratos válidos: el múltiplo de QTY_STEP más cercano a
// usd / precio. Devuelve 0 si el monto no llega a medio paso y null sin
// monto o precio utilizable. Se opera en centésimas enteras (1 / QTY_STEP)
// para que 37,5 / 100 redondee a 0,38 y no a 0,37 por coma flotante.
export function usdToContracts(usd, price) {
  const u = Number(usd);
  const p = Number(price);
  if (usd == null || price == null || !Number.isFinite(u) || !Number.isFinite(p) || u < 0 || p <= 0) return null;
  const steps = Math.round((u * Math.round(1 / QTY_STEP)) / p);
  return steps / Math.round(1 / QTY_STEP);
}

// Paso del stepper en USD: una décima de la magnitud del monto, mínimo 1
// (50 → 1, 100 → 10, 2500 → 100).
export function usdStep(usd) {
  const n = Math.abs(Number(usd));
  if (!Number.isFinite(n) || n < 10) return 1;
  return Math.max(1, 10 ** (Math.floor(Math.log10(n)) - 1));
}

// Símbolo Binance:BTC-261031-72000-C → { underlying, expiry, strike, type }.
export function parseSymbol(symbol) {
  const parts = String(symbol || '').split('-');
  if (parts.length !== 4) return null;
  const [underlying, expiry, strike, type] = parts;
  const k = Number(strike);
  if (!Number.isFinite(k) || (type !== 'C' && type !== 'P')) return null;
  return { underlying, expiry, strike: k, type };
}

/**
 * Resumen del ticket.
 * @param {object} p
 * @param {'BUY'|'SELL'} p.side
 * @param {'C'|'P'} p.type
 * @param {number} p.strike
 * @param {number} p.price  precio límite por contrato (USDT)
 * @param {number} p.qty    contratos
 * @param {number} p.spot   precio del subyacente
 * @param {object} [p.leg]  pata de la cadena (mark, delta, theta…)
 */
export function computeTicket({ side, type, strike, price, qty, spot, leg = {} }) {
  const valid = Number.isFinite(price) && price > 0 && Number.isFinite(qty) && qty > 0;
  if (!valid) {
    return { valid: false, premium: null, fee: null, margin: null, delta: null, theta: null, breakeven: null };
  }
  const sign = side === 'BUY' ? 1 : -1;
  const premiumAbs = price * qty;
  const S = Number(spot);
  const hasSpot = Number.isFinite(S) && S > 0;

  const fee = hasSpot
    ? Math.min(S * qty * FEE_NOTIONAL_RATE, premiumAbs * FEE_PREMIUM_CAP)
    : premiumAbs * FEE_PREMIUM_CAP;

  // Comprar solo exige pagar la prima. Vender exige margen: estimación con
  // la fórmula de Binance (mark + máx(15 % del índice − OTM, 10 % del índice)).
  let margin = null;
  if (side === 'SELL' && hasSpot) {
    const mark = Number.isFinite(Number(leg.mark)) ? Number(leg.mark) : price;
    const otm = type === 'C' ? Math.max(strike - S, 0) : Math.max(S - strike, 0);
    margin = (mark + Math.max(0.15 * S - otm, 0.1 * S)) * qty;
  }

  const legDelta = Number(leg.delta);
  const legTheta = Number(leg.theta);
  return {
    valid: true,
    premium: -sign * premiumAbs, // positivo = se cobra
    fee,
    margin,
    delta: Number.isFinite(legDelta) ? legDelta * qty * sign : null,
    theta: Number.isFinite(legTheta) ? legTheta * qty * sign : null,
    breakeven: type === 'C' ? strike + price : strike - price,
  };
}

// Precio con el que se rellena el ticket: comprar al ask, vender al bid
// (con el mark como respaldo si el libro está vacío).
export function quoteFor(leg, side) {
  if (!leg) return null;
  const primary = side === 'BUY' ? leg.ask : leg.bid;
  const n = Number(primary);
  if (Number.isFinite(n) && n > 0) return n;
  const mark = Number(leg.mark);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
}
