/**
 * Pricing de opciones europeas (Black-Scholes) sin dependencias ni E/S.
 *
 * Convenciones:
 * - `T` en años, `iv` como decimal (0.55 = 55 %), `r` tasa continua (0 por
 *   defecto: las opciones de Binance liquidan en USDT y la prima va al contado).
 * - `type` es 'C' o 'P' (también se aceptan 'call'/'put').
 * - `theta` se expresa por día y `vega` por punto de volatilidad (0.01).
 */

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function normalizeType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'C' || t === 'CALL') return 'C';
  if (t === 'P' || t === 'PUT') return 'P';
  throw new Error(`Tipo de opción inválido: ${type}`);
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * CDF normal estándar (aproximación de Abramowitz-Stegun 7.1.26 sobre erf,
 * error < 1.5e-7, suficiente para precios y deltas).
 */
function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function intrinsic({ S, K, type }) {
  return normalizeType(type) === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

function d1d2({ S, K, T, iv, r = 0 }) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  return { d1, d2: d1 - iv * sqrtT, sqrtT };
}

function isDegenerate({ S, K, T, iv }) {
  return !(S > 0) || !(K > 0) || !(T > 0) || !(iv > 0);
}

/** Precio Black-Scholes. Vencida o sin volatilidad → valor intrínseco descontado. */
function blackScholes({ S, K, T, iv, type, r = 0 }) {
  const kind = normalizeType(type);
  if (isDegenerate({ S, K, T, iv })) {
    const disc = T > 0 ? Math.exp(-r * T) : 1;
    return kind === 'C' ? Math.max(S - K * disc, 0) : Math.max(K * disc - S, 0);
  }
  const { d1, d2 } = d1d2({ S, K, T, iv, r });
  const disc = Math.exp(-r * T);
  if (kind === 'C') return S * normCdf(d1) - K * disc * normCdf(d2);
  return K * disc * normCdf(-d2) - S * normCdf(-d1);
}

function greeks({ S, K, T, iv, type, r = 0 }) {
  const kind = normalizeType(type);
  if (isDegenerate({ S, K, T, iv })) {
    const itm = kind === 'C' ? S > K : S < K;
    return { delta: itm ? (kind === 'C' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const { d1, d2, sqrtT } = d1d2({ S, K, T, iv, r });
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const delta = kind === 'C' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S * iv * sqrtT);
  const vega = (S * pdf * sqrtT) / 100;
  const decay = -(S * pdf * iv) / (2 * sqrtT);
  const thetaYear = kind === 'C'
    ? decay - r * K * disc * normCdf(d2)
    : decay + r * K * disc * normCdf(-d2);
  return { delta, gamma, theta: thetaYear / 365, vega };
}

/**
 * Volatilidad implícita: Newton-Raphson con salvaguarda de bisección.
 * Devuelve null si el precio está fuera de los límites de no arbitraje.
 */
function impliedVol({ price, S, K, T, type, r = 0, tolerance = 1e-6, maxIterations = 100 }) {
  const kind = normalizeType(type);
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const disc = Math.exp(-r * T);
  const lower = kind === 'C' ? Math.max(S - K * disc, 0) : Math.max(K * disc - S, 0);
  const upper = kind === 'C' ? S : K * disc;
  if (price <= lower || price >= upper) return null;

  let lo = 1e-4;
  let hi = 10;
  let iv = 0.5;
  for (let i = 0; i < maxIterations; i += 1) {
    const value = blackScholes({ S, K, T, iv, type: kind, r });
    const diff = value - price;
    if (Math.abs(diff) < tolerance) return iv;
    if (diff > 0) hi = iv; else lo = iv;
    const vega = greeks({ S, K, T, iv, type: kind, r }).vega * 100;
    let next = vega > 1e-10 ? iv - diff / vega : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    iv = next;
    if (hi - lo < 1e-10) break;
  }
  return iv;
}

/** Años hasta `expiryMs` desde `nowMs` (nunca negativo). */
function yearsBetween(nowMs, expiryMs) {
  return Math.max(0, (Number(expiryMs) - Number(nowMs)) / MS_PER_YEAR);
}

module.exports = {
  MS_PER_YEAR,
  normCdf,
  normPdf,
  intrinsic,
  blackScholes,
  greeks,
  impliedVol,
  yearsBetween,
  normalizeType,
};
