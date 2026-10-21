/**
 * Nombres de contratos de Deribit y utilidades de vencimiento.
 *
 * Formato inverso (BTC, ETH):  ETH-31OCT25-4000-C
 * Formato USDC (SOL, XRP...):  XRP_USDC-5DEC25-2d2-C
 *
 * El dia va sin cero, el mes en mayusculas de 3 letras, el anio en 2 digitos,
 * el decimal del strike se escribe con 'd' y el vencimiento es a las 08:00 UTC.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const EXPIRY_HOUR_UTC = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const FRIDAY = 5;

const UNDERLYINGS = {
  BTC: {
    prefix: 'BTC',
    currency: 'BTC',
    inverse: true,
    perpetual: 'BTC-PERPETUAL',
    binanceSymbol: 'BTCUSDT',
    strikeSteps: [1000, 500],
  },
  ETH: {
    prefix: 'ETH',
    currency: 'ETH',
    inverse: true,
    perpetual: 'ETH-PERPETUAL',
    binanceSymbol: 'ETHUSDT',
    strikeSteps: [50, 25, 100],
  },
  SOL: {
    prefix: 'SOL_USDC',
    currency: 'USDC',
    inverse: false,
    perpetual: null,
    binanceSymbol: 'SOLUSDT',
    strikeSteps: [5, 2, 10],
  },
  XRP: {
    prefix: 'XRP_USDC',
    currency: 'USDC',
    inverse: false,
    perpetual: null,
    binanceSymbol: 'XRPUSDT',
    strikeSteps: [0.1, 0.05],
  },
  AVAX: {
    prefix: 'AVAX_USDC',
    currency: 'USDC',
    inverse: false,
    perpetual: null,
    binanceSymbol: 'AVAXUSDT',
    strikeSteps: [1, 0.5],
  },
  TRX: {
    prefix: 'TRX_USDC',
    currency: 'USDC',
    inverse: false,
    perpetual: null,
    binanceSymbol: 'TRXUSDT',
    strikeSteps: [0.01, 0.005],
  },
  HYPE: {
    prefix: 'HYPE_USDC',
    currency: 'USDC',
    inverse: false,
    perpetual: null,
    binanceSymbol: 'HYPEUSDT',
    strikeSteps: [1, 0.5],
  },
};

const EXPIRY_CODE_RE = /^(\d{1,2})([A-Z]{3})(\d{2})$/;

/** Convierte un instante de vencimiento (ms) en su codigo, p. ej. '31OCT25'. */
function formatExpiryCode(expiryMs) {
  const d = new Date(expiryMs);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${yy}`;
}

/** Convierte un codigo de vencimiento en ms, a las 08:00 UTC. Lanza si es invalido. */
function parseExpiryCode(code) {
  const m = EXPIRY_CODE_RE.exec(code);
  if (!m) throw new Error(`Codigo de vencimiento invalido: ${code}`);
  const month = MONTHS.indexOf(m[2]);
  if (month === -1) throw new Error(`Mes invalido en vencimiento: ${code}`);
  return Date.UTC(2000 + Number(m[3]), month, Number(m[1]), EXPIRY_HOUR_UTC);
}

/** Formatea un strike: el decimal se escribe con 'd' (2.2 -> '2d2'). */
function formatStrike(strike) {
  return String(strike).replace('.', 'd');
}

/** Construye el nombre de un contrato de opcion de Deribit. */
function buildInstrumentName({ underlying, expiryMs, strike, type }) {
  const u = UNDERLYINGS[underlying];
  if (!u) throw new Error(`Subyacente sin Deribit: ${underlying}`);
  return `${u.prefix}-${formatExpiryCode(expiryMs)}-${formatStrike(strike)}-${type}`;
}

const NAME_RE = /^([A-Z]+(?:_USDC)?)-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:d\d+)?)-([CP])$/;

/**
 * Descompone un nombre de contrato. Devuelve null si no es una opcion con
 * vencimiento valido (perpetuos, futuros o subyacentes desconocidos).
 */
function parseInstrumentName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, prefix, expiryCode, strikeRaw, type] = m;

  const underlying = Object.keys(UNDERLYINGS).find((key) => UNDERLYINGS[key].prefix === prefix);
  if (!underlying) return null;

  let expiryMs;
  try {
    expiryMs = parseExpiryCode(expiryCode);
  } catch {
    return null;
  }
  // Rechaza fechas inexistentes (p. ej. 31FEB25) que Date.UTC desplazaria.
  if (formatExpiryCode(expiryMs) !== expiryCode) return null;

  return {
    underlying,
    prefix,
    expiryCode,
    expiryMs,
    strike: Number(strikeRaw.replace('d', '.')),
    type,
    inverse: UNDERLYINGS[underlying].inverse,
  };
}

/** Vencimientos de viernes (08:00 UTC) dentro de [fromMs, toMs], en orden. */
function fridaysBetween(fromMs, toMs) {
  const start = new Date(fromMs);
  let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), EXPIRY_HOUR_UTC);
  if (t < fromMs) t += DAY_MS;

  const out = [];
  for (; t <= toMs; t += DAY_MS) {
    if (new Date(t).getUTCDay() === FRIDAY) out.push(t);
  }
  return out;
}

module.exports = {
  UNDERLYINGS,
  formatExpiryCode,
  parseExpiryCode,
  formatStrike,
  buildInstrumentName,
  parseInstrumentName,
  fridaysBetween,
};
