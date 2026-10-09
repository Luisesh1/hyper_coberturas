const DAY_MS = 24 * 60 * 60 * 1000;

// Variación de las últimas 24h a partir de las velas cargadas (time en ms).
// Referencia: cierre de la última vela con time <= (última − 24h). Si el
// histórico no llega tan atrás (p. ej. 500 velas de 1m) o las velas duran más
// de un día (1W/1M, no hay ventana de 24h), devuelve null: mejor no mostrar
// nada que inventar un valor.
export function computePriceChange(candles, livePrice) {
  if (!Array.isArray(candles) || candles.length < 2) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const lastTime = Number(last?.time);
  if (!Number.isFinite(lastTime)) return null;
  if (lastTime - Number(prev?.time) > DAY_MS) return null;

  const target = lastTime - DAY_MS;
  // Recorremos desde el final: la referencia suele estar cerca de la cola.
  let ref = null;
  for (let i = candles.length - 2; i >= 0; i -= 1) {
    if (Number(candles[i]?.time) <= target) { ref = candles[i]; break; }
  }
  if (!ref) return null;

  const reference = Number(ref.close);
  if (!Number.isFinite(reference) || reference <= 0) return null;

  const live = livePrice == null ? NaN : Number(livePrice);
  const current = Number.isFinite(live) ? live : Number(last.close);
  if (!Number.isFinite(current)) return null;

  const change = current - reference;
  return { current, reference, change, percent: (change / reference) * 100 };
}
