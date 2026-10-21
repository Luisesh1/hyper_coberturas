// "Saltar a su vida": al superponer una opción que venció antes de la primera
// vela cargada, el principal se recarga terminando poco después del
// vencimiento y la vista encuadra los 7 días previos.
export const DAY_MS = 86_400_000;
export const FORWARD_LIMIT = 500;

export function jumpTarget(spec, firstCandleMs) {
  const expiryMs = spec?.kind === 'option' ? spec.option?.expiryMs : null;
  if (!Number.isFinite(expiryMs) || !Number.isFinite(firstCandleMs) || expiryMs >= firstCandleMs) return null;
  return { endTime: expiryMs + DAY_MS, range: { from: expiryMs - 7 * DAY_MS, to: expiryMs } };
}

// Tramo siguiente al cargar hacia delante desde una vista histórica.
export function forwardWindow(newestMs, tfMs, now = Date.now()) {
  const endTime = Math.min(newestMs + FORWARD_LIMIT * tfMs, now);
  return { startTime: newestMs + 1, endTime, reachesNow: endTime >= now };
}

// Índices lógicos (posiciones en `candles`, time en ms) que cubren `range`.
// Se encuadra por índice: setVisibleRange por tiempo justo tras un setData
// puede resolverse contra los datos anteriores.
export function logicalRangeFor(candles, range) {
  if (!candles?.length || !range) return null;
  const last = candles.length - 1;
  let from = candles.findIndex((c) => c.time >= range.from);
  if (from < 0) from = last;
  let to = from;
  while (to < last && candles[to + 1].time <= range.to) to++;
  return { from, to };
}
