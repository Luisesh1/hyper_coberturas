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

// Paso de cantidad del stepper: décimas a partir de 0,1 contratos y
// centésimas por debajo (el mínimo de Binance es 0,01).
export const QTY_COARSE_STEP = 0.1;
export function qtyStep(qty, direction = 1) {
  const q = Number(qty);
  if (direction < 0) return q > QTY_COARSE_STEP ? QTY_COARSE_STEP : QTY_STEP;
  return q >= QTY_COARSE_STEP ? QTY_COARSE_STEP : QTY_STEP;
}

// Símbolo Binance: BTC-261031-72000-C → { underlying, expiry, strike, type }.
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
