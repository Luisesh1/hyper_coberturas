/**
 * Cadena de opciones sintética (Black-Scholes + sonrisa fija) con la misma
 * forma que `getChain` de options-market.service. La usa el backtest con las
 * fuentes `dvol` y `realized`, donde no hay precios históricos de opciones.
 */

const { blackScholes, greeks, yearsBetween } = require('./options-pricing');
const { DAY_MS, EXPIRY_HOUR_UTC, buildSymbol, msToExpiryCode } = require('./options-utils');

// Sonrisa fija sobre m = ln(K/S): curvatura simétrica y sesgo bajista (puts más caras).
const SMILE = { curvature: 1.5, skew: -0.25, floorRatio: 0.6, capRatio: 3 };
const STRIKES_PER_SIDE = 30;

function smileIv(atmIv, spot, strike, smile = SMILE) {
  const m = Math.log(strike / spot);
  const factor = 1 + smile.curvature * m * m + smile.skew * m;
  return atmIv * Math.min(smile.capRatio, Math.max(smile.floorRatio, factor));
}

/** Paso de strikes "redondo" (1, 2, 2.5, 5 × 10^n) cercano al 1,25 % del spot. */
function strikeStep(spot) {
  const raw = spot * 0.0125;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const base = raw / pow;
  const nice = base < 1.5 ? 1 : base < 2.25 ? 2 : base < 3.5 ? 2.5 : base < 7.5 ? 5 : 10;
  return nice * pow;
}

/**
 * Vencimientos al estilo Binance: diarios para los próximos 3 días y los
 * viernes de las próximas 12 semanas, todos a las 08:00 UTC.
 */
function syntheticExpiries(now) {
  const start = new Date(now);
  const firstDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), EXPIRY_HOUR_UTC);
  const codes = new Map();
  for (let i = 0; i <= 90; i += 1) {
    const ms = firstDay + i * DAY_MS;
    if (ms <= now) continue;
    const isFriday = new Date(ms).getUTCDay() === 5;
    const daysAhead = (ms - now) / DAY_MS;
    if (daysAhead <= 3 || isFriday) codes.set(msToExpiryCode(ms), ms);
  }
  return [...codes.entries()].map(([code, ms]) => ({
    code,
    label: new Date(ms).toISOString().slice(0, 10),
    dte: (ms - now) / DAY_MS,
    expiryMs: ms,
  }));
}

/** Pata sintética: mark BS, bid/ask con `spreadPct` total alrededor del mark. */
function syntheticLeg({ underlying, expiry, expiryMs, strike, type, spot, now, atmIv, spreadPct = 0 }) {
  const iv = smileIv(atmIv, spot, strike);
  const T = yearsBetween(now, expiryMs);
  const mark = blackScholes({ S: spot, K: strike, T, iv, type });
  const g = greeks({ S: spot, K: strike, T, iv, type });
  const half = (Math.max(0, spreadPct) / 100) / 2;
  return {
    symbol: buildSymbol({ underlying, expiry, strike, type }),
    bid: mark * (1 - half),
    ask: mark * (1 + half),
    mark,
    iv,
    delta: g.delta,
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    openInterest: 0,
  };
}

function buildSyntheticChain({ underlying, spot, now, expiry, atmIv, spreadPct = 0 }) {
  const step = strikeStep(spot);
  const center = Math.round(spot / step) * step;
  const rows = [];
  for (let i = -STRIKES_PER_SIDE; i <= STRIKES_PER_SIDE; i += 1) {
    const strike = Number((center + i * step).toFixed(8));
    if (strike <= 0) continue;
    const base = { underlying, expiry: expiry.code, expiryMs: expiry.expiryMs, strike, spot, now, atmIv, spreadPct };
    rows.push({
      strike,
      call: syntheticLeg({ ...base, type: 'C' }),
      put: syntheticLeg({ ...base, type: 'P' }),
    });
  }
  return { underlying, spot, expiry: expiry.code, expiryMs: expiry.expiryMs, rows };
}

module.exports = {
  SMILE,
  smileIv,
  strikeStep,
  syntheticExpiries,
  syntheticLeg,
  buildSyntheticChain,
};
