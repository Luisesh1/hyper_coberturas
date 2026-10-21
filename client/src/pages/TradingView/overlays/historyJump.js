// "Saltar a su vida": al superponer una opción que venció antes de la primera
// vela cargada, el principal se recarga terminando poco después del
// vencimiento y la vista encuadra los 7 días previos (o lo cargado de ellos).
// El margen tras el vencimiento depende de la temporalidad: con 500 velas de
// 1m (~8 h) un día de margen dejaría todo el tramo después del vencimiento.
export const DAY_MS = 86_400_000;
export const FORWARD_LIMIT = 500;
export const JUMP_TAIL_CANDLES = 50; // velas tras el vencimiento (como mucho 1 d)

export function jumpTarget(spec, firstCandleMs, tfMs = DAY_MS) {
  const expiryMs = spec?.kind === 'option' ? spec.option?.expiryMs : null;
  if (!Number.isFinite(expiryMs) || !Number.isFinite(firstCandleMs) || expiryMs >= firstCandleMs) return null;
  const tail = Math.min(DAY_MS, JUMP_TAIL_CANDLES * (Number.isFinite(tfMs) && tfMs > 0 ? tfMs : DAY_MS));
  return { endTime: expiryMs + tail, range: { from: expiryMs - 7 * DAY_MS, to: expiryMs } };
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

// Une velas por `time` (las de `incoming` pisan a las existentes) y ordena.
// Las cargas por ambos bordes leen candlesRef tras su await y fusionan con
// esto, así ninguna pisa la página que añadió la otra.
export function mergeCandles(current, incoming) {
  const byTime = new Map();
  for (const c of current || []) byTime.set(c.time, c);
  for (const c of incoming || []) if (c && Number.isFinite(c.time)) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
