// Precio límite al medio del libro, ajustado a la rejilla del contrato
// (PRICE_FILTER de Binance: precio válido = minPrice + k·tickSize).
// Puro. Se opera en enteros escalados para evitar deriva de coma flotante,
// igual que priceGrid en client/src/pages/Options/manual/ticketMath.js.

function decimalsOf(n) {
  const text = String(n);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

// BUY redondea hacia arriba y SELL hacia abajo (lado que favorece el fill);
// el resultado queda siempre dentro de [bid, ask]. Devuelve null si el libro
// no tiene ambos lados o está cruzado.
function midLimitPrice({ bid, ask, side, tickSize, minPrice } = {}) {
  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0 || a < b) return null;
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return (b + a) / 2;
  const minRaw = Number(minPrice);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 0;
  const scale = 10 ** Math.max(decimalsOf(tick), decimalsOf(min));
  const t = Math.round(tick * scale);
  const m = Math.round(min * scale);
  const bs = Math.round(b * scale);
  const as = Math.round(a * scale);
  const mid = (bs + as) / 2;
  const buy = String(side).toUpperCase() === 'BUY';
  let k = (buy ? Math.ceil : Math.floor)((mid - m) / t);
  let p = m + k * t;
  // Acota a [bid, ask] sobre la rejilla.
  if (p > as) p = m + Math.floor((as - m) / t) * t;
  if (p < bs) p = m + Math.ceil((bs - m) / t) * t;
  if (p < bs || p > as) return null; // ningún tick válido dentro del spread
  return p / scale;
}

module.exports = { midLimitPrice };
