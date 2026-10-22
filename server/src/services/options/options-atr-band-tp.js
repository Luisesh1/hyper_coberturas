'use strict';

/**
 * Banda ATR (misma fórmula que el indicador «ATR Bands» del cliente):
 * último cierre ± multiplicador × ATR(longitud), con ATR de Wilder como
 * `technicalindicators` (TR desde la 2ª vela, 1ª media = SMA de `length` TR,
 * después (prev × (length-1) + tr) / length). Sólo velas cerradas
 * (`closeTime < now`). Filas Binance: [openTime, o, h, l, c, v, closeTime].
 * Devuelve { close, atr, upper, lower, closeTime, multiplier } o null.
 */
function wilderAtrBands(candles, { length = 14, multiplier = 2, now = Date.now() } = {}) {
  if (!Number.isInteger(length) || length < 2 || !(multiplier > 0) || !Array.isArray(candles)) return null;
  const closed = candles.filter((row) =>
    Array.isArray(row) && row.length >= 7 && Number.isFinite(Number(row[6])) && Number(row[6]) < now);
  if (closed.length < length + 1) return null;
  let lastOpen = -1;
  const rows = [];
  for (const row of closed) {
    const [openTime, , high, low, close] = row.map(Number);
    if (!Number.isFinite(openTime) || openTime <= lastOpen ||
        !(high > 0) || !(low > 0) || low > high ||
        !(close > 0) || close > high || close < low) return null;
    lastOpen = openTime;
    rows.push({ high, low, close, closeTime: Number(row[6]) });
  }
  const tr = [];
  for (let i = 1; i < rows.length; i += 1) {
    const { high, low } = rows[i];
    const prev = rows[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  let atr = tr.slice(0, length).reduce((s, v) => s + v, 0) / length;
  for (let i = length; i < tr.length; i += 1) atr = (atr * (length - 1) + tr[i]) / length;
  if (!(atr > 0) || !Number.isFinite(atr)) return null;
  const last = rows[rows.length - 1];
  return {
    close: last.close, atr, multiplier, closeTime: last.closeTime,
    upper: last.close + multiplier * atr, lower: last.close - multiplier * atr,
  };
}

/**
 * Precio de venta = fillPrice × (1 + min(distancia% × apalancamiento, tope)).
 * - band: resultado de wilderAtrBands ({ close, atr, multiplier, upper, lower }).
 *   Call usa `upper`, put `lower`; si el spot ya rebasó la banda (distancia ≤ 0)
 *   la distancia se mide desde el último cierre: multiplier × atr / close.
 * - leverage nominal = spot / fillPrice. maxGainPct en % (200 = +200 %).
 * - Redondea hacia arriba al tick anclado en minPrice. null si price ≤ fillPrice.
 * Devuelve { price, distancePct, leverage, rawGainPct, appliedGainPct, capped, bandValue }
 * (los porcentajes en puntos porcentuales: 2 = 2 %).
 */
function atrBandTakeProfit({ fillPrice, spot, type, band, tickSize, minPrice = 0, maxGainPct }) {
  const fill = Number(fillPrice);
  const s = Number(spot);
  const tick = Number(tickSize);
  const origin = Number(minPrice);
  const cap = Number(maxGainPct);
  if (!(fill > 0) || !(s > 0) || !(tick > 0) || !Number.isFinite(origin) || origin < 0 ||
      !(cap > 0) || !band || !['C', 'P'].includes(type)) return null;
  const bandValue = Number(type === 'C' ? band.upper : band.lower);
  if (!Number.isFinite(bandValue)) return null;
  let distance = type === 'C' ? bandValue - s : s - bandValue;
  if (!(distance > 0)) {
    const close = Number(band.close);
    distance = (Number(band.multiplier) * Number(band.atr)) / close * s;
    if (!(close > 0) || !(distance > 0)) return null;
  }
  const distancePct = (distance / s) * 100;
  const leverage = s / fill;
  const rawGainPct = distancePct * leverage;
  const capped = rawGainPct > cap;
  const appliedGainPct = capped ? cap : rawGainPct;
  const raw = fill * (1 + appliedGainPct / 100);
  const steps = Math.ceil((raw - origin) / tick - 1e-9);
  const price = Number((origin + steps * tick).toFixed(10));
  if (!(price > fill)) return null;
  return { price, distancePct, leverage, rawGainPct, appliedGainPct, capped, bandValue };
}

module.exports = { wilderAtrBands, atrBandTakeProfit };
