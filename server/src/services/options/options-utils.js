/**
 * Utilidades puras compartidas por el runner de estrategias y el backtest:
 * símbolos de Binance Opciones, vencimientos y el modelo de comisiones.
 */

// Binance Opciones vence a las 08:00 UTC del día de vencimiento.
const EXPIRY_HOUR_UTC = 8;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Comisión de trading: mín(0,03 % del nocional del subyacente, 10 % de la prima).
const TRADE_FEE_RATE_PCT = 0.03;
const FEE_PREMIUM_CAP_PCT = 10;
// Comisión de ejercicio al vencimiento (solo si vence en el dinero).
const EXERCISE_FEE_RATE_PCT = 0.015;

function expiryCodeToMs(code) {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(String(code || ''));
  if (!match) return null;
  return Date.UTC(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3]), EXPIRY_HOUR_UTC);
}

function msToExpiryCode(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function formatStrike(strike) {
  const n = Number(strike);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(8)));
}

function buildSymbol({ underlying, expiry, strike, type }) {
  return `${String(underlying).toUpperCase()}-${expiry}-${formatStrike(strike)}-${type}`;
}

/** 'BTC-241227-60000-C' → { underlying, expiry, expiryMs, strike, type } */
function parseSymbol(symbol) {
  const match = /^([A-Z0-9]+)-(\d{6})-([\d.]+)-([CP])$/.exec(String(symbol || '').toUpperCase());
  if (!match) return null;
  return {
    underlying: match[1],
    expiry: match[2],
    expiryMs: expiryCodeToMs(match[2]),
    strike: Number(match[3]),
    type: match[4],
  };
}

/** Acepta IV como decimal (0.55) o en porcentaje (55) y la devuelve decimal. */
function ivToDecimal(iv) {
  const n = Number(iv);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 3 ? n / 100 : n;
}

function num(value) {
  // Number(null) y Number('') valen 0: un dato ausente no debe convertirse en precio 0.
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Precio de llenado contra el libro: se compra al ask y se vende al bid. */
function fillPrice(quote, side) {
  if (!quote) return null;
  const price = side === 'BUY' ? num(quote.ask) : num(quote.bid);
  return price != null && price > 0 ? price : null;
}

/** Comisión de un llenado en USDT. */
function tradeFee({ spot, quantity, price, ratePct = TRADE_FEE_RATE_PCT, capPct = FEE_PREMIUM_CAP_PCT }) {
  const notionalFee = (Number(ratePct) / 100) * Number(spot) * Number(quantity);
  const premiumCap = (Number(capPct) / 100) * Number(price) * Number(quantity);
  const fee = Math.min(notionalFee, premiumCap);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function exerciseFee({ spot, quantity, intrinsicValue }) {
  if (!(intrinsicValue > 0)) return 0;
  return tradeFee({ spot, quantity, price: intrinsicValue, ratePct: EXERCISE_FEE_RATE_PCT });
}

/** Prima con signo: positiva si se cobra (venta), negativa si se paga. */
function signedPremium(side, price, quantity) {
  const amount = Number(price) * Number(quantity);
  return side === 'SELL' ? amount : -amount;
}

/** PnL bruto (sin comisiones) de cerrar una posición a `exitPrice`. */
function grossPnl({ side, entryPrice, exitPrice, quantity }) {
  const diff = Number(exitPrice) - Number(entryPrice);
  return (side === 'BUY' ? diff : -diff) * Number(quantity);
}

function oppositeSide(side) {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

module.exports = {
  EXPIRY_HOUR_UTC,
  HOUR_MS,
  DAY_MS,
  TRADE_FEE_RATE_PCT,
  FEE_PREMIUM_CAP_PCT,
  EXERCISE_FEE_RATE_PCT,
  expiryCodeToMs,
  msToExpiryCode,
  buildSymbol,
  parseSymbol,
  ivToDecimal,
  fillPrice,
  tradeFee,
  exerciseFee,
  signedPremium,
  grossPnl,
  oppositeSide,
  num,
};
