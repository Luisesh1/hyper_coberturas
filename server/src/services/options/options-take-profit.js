/**
 * Proyección conservadora de TP para opciones: ATR realizado del subyacente
 * combinado con el movimiento implícito y valoración Black-Scholes.
 * Sólo calcula una cotización; NUNCA envía órdenes.
 */
const { blackScholes, yearsBetween } = require('./options-pricing');

function hourlyAtr(rows, period = 14, now = Date.now()) {
  if (!Number.isInteger(period) || period < 2 || !Array.isArray(rows)) return null;
  const closed = rows.filter((row) =>
    Array.isArray(row) && row.length >= 7 && Number.isFinite(Number(row[6])) && Number(row[6]) < now
  );
  if (closed.length < period + 1) return null;
  const recent = closed.slice(-(period + 1));
  let lastOpenTime = -1;
  for (const row of recent) {
    const [openTime, , high, low, close] = row.map(Number);
    if (!Number.isFinite(openTime) || openTime <= lastOpenTime ||
        !(high > 0) || !(low > 0) || low > high ||
        !(close > 0) || close > high || close < low) return null;
    lastOpenTime = openTime;
  }
  const tr = [];
  for (let i = 1; i < recent.length; i += 1) {
    const high = Number(recent[i][2]);
    const low = Number(recent[i][3]);
    const prevClose = Number(recent[i - 1][4]);
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const atr = tr.reduce((sum, value) => sum + value, 0) / period;
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

/**
 * Toma la prima real promedio como punto de referencia, evitando asumir
 * que la prima negociada equivale exactamente al modelo teórico.
 * El modelo sólo proyecta el CAMBIO de prima para una variación favorable
 * del subyacente durante horizonHours. No garantiza ejecución ni ganancia.
 */
function projectTakeProfit({
  entryPrice, spot, strike, iv, type, side, expiryMs, nowMs,
  atrHourly, tickSize, minPrice = 0, atrMultiplier = 1, horizonHours = 4,
}) {
  const input = [entryPrice, spot, strike, iv, expiryMs, nowMs, atrHourly, tickSize, minPrice, atrMultiplier, horizonHours];
  if (input.some((v) => !Number.isFinite(Number(v))) ||
      !(entryPrice > 0 && spot > 0 && strike > 0 && iv >= 0.01 && iv <= 5 &&
        atrHourly > 0 && tickSize > 0 && minPrice >= 0 && atrMultiplier > 0 && atrMultiplier <= 4 &&
        horizonHours > 0 && horizonHours <= 24) ||
      !['BUY', 'SELL'].includes(side) || !['C', 'P'].includes(type)) return null;

  const timeToExpiry = yearsBetween(nowMs, expiryMs);
  const horizonYears = horizonHours / (365 * 24);
  if (!(timeToExpiry > horizonYears)) return null;

  // ATR(14) de velas 1h y desviación implícita durante el mismo horizonte.
  // Blend al 50 % para evitar confiar exclusivamente en uno de los dos.
  const realizedMove = Number(atrHourly) * Math.sqrt(horizonHours) * Number(atrMultiplier);
  const impliedMove = Number(spot) * Number(iv) * Math.sqrt(horizonYears);
  const favorableMove = Math.min(0.4 * Number(spot), (realizedMove + impliedMove) / 2);
  const up = (type === 'C' && side === 'BUY') || (type === 'P' && side === 'SELL');
  const targetSpot = Number(spot) + (up ? favorableMove : -favorableMove);
  if (!(targetSpot > 0)) return null;

  const theoreticalNow = blackScholes({
    S: Number(spot), K: Number(strike), T: timeToExpiry, iv: Number(iv), type,
  });
  const theoreticalLater = blackScholes({
    S: targetSpot, K: Number(strike), T: timeToExpiry - horizonYears,
    iv: Number(iv), type,
  });
  // Prima proyectada anclada al fill real (no al mark).
  const raw = Number(entryPrice) + theoreticalLater - theoreticalNow;
  const tick = Number(tickSize);
  // Binance PRICE_FILTER exige (price - minPrice) % tickSize == 0.
  const origin = Number(minPrice);
  const ticks = (raw - origin) / tick;
  const steps = side === 'BUY' ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  const price = Number((origin + steps * tick).toFixed(10));
  if (!Number.isFinite(price) || price <= 0 || price < origin ||
      (side === 'BUY' && price <= entryPrice + tick * 0.5) ||
      (side === 'SELL' && price >= entryPrice - tick * 0.5)) return null;
  return {
    price,
    underlyingTarget: targetSpot,
    projectedGrossPct: (side === 'BUY' ? price / entryPrice - 1 : 1 - price / entryPrice) * 100,
    atrHourly: Number(atrHourly),
    impliedMove,
    realizedMove,
    horizonHours: Number(horizonHours),
  };
}

module.exports = { hourlyAtr, projectTakeProfit };
