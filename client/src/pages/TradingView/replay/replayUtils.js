// Helpers puros para el modo replay del gráfico de TradingView.
// No tocan el chart ni el DOM: alineación de buckets, agregación OHLC,
// elección de sub-temporalidades válidas y selección de anchor aleatorio.

const TF_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
  '1w': 604_800,
  '1M': 2_592_000, // aproximación: 30 días
};

const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];

export function timeframeSeconds(tf) {
  return TF_SECONDS[tf] || 0;
}

// Sub-TFs válidas para una TF mostrada: cualquier TF estrictamente menor
// cuya duración divide exactamente la de la TF mostrada (para que los
// buckets HTF se compongan de un número entero de sub-velas).
// Caso especial 1M: se aproxima a 30 días — devolvemos sub-TFs grandes
// (4h, 1d) sin requerir divisibilidad exacta porque el mes no es regular.
export function getLowerTimeframes(htfTf) {
  if (htfTf === '1M') return ['4h', '1d'];
  const htfSec = TF_SECONDS[htfTf];
  if (!htfSec) return [];
  const idx = TF_ORDER.indexOf(htfTf);
  if (idx <= 0) return [];
  return TF_ORDER.slice(0, idx).filter((tf) => htfSec % TF_SECONDS[tf] === 0);
}

// Default = la inmediatamente menor disponible.
export function defaultLowerTimeframe(htfTf) {
  const candidates = getLowerTimeframes(htfTf);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// Alinea un timestamp (ms) al inicio del bucket de la TF dada.
// Para 1M usamos límites de mes natural UTC (no aproximación de 30d) —
// así "el mes de un timestamp" coincide con cómo lo entrega un provider real.
export function alignToTimeframe(timestampMs, tf) {
  if (tf === '1M') {
    const d = new Date(timestampMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (tf === '1w') {
    // Lunes 00:00 UTC. JS getUTCDay: 0=Sunday..6=Saturday → ((day+6)%7) días desde el lunes.
    const d = new Date(timestampMs);
    const dayOffset = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOffset);
  }
  const sec = TF_SECONDS[tf];
  if (!sec) return timestampMs;
  const ms = sec * 1000;
  return Math.floor(timestampMs / ms) * ms;
}

// Inicio del siguiente bucket HTF dado el inicio del actual.
export function nextBucketStart(bucketStartMs, tf) {
  if (tf === '1M') {
    const d = new Date(bucketStartMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return bucketStartMs + TF_SECONDS[tf] * 1000;
}

// Funde una sub-vela (ltfBar) en la HTF en formación.
// Si no hay HTF en formación, la inicia con el bucket que contiene la sub-vela.
// Devuelve el nuevo objeto {time, open, high, low, close} (no muta input).
export function foldLtfIntoHtf(ltfBar, htfInProgress, htfTf) {
  const bucketStart = alignToTimeframe(ltfBar.time, htfTf);
  if (!htfInProgress || htfInProgress.time !== bucketStart) {
    return {
      time: bucketStart,
      open: ltfBar.open,
      high: ltfBar.high,
      low: ltfBar.low,
      close: ltfBar.close,
    };
  }
  return {
    time: htfInProgress.time,
    open: htfInProgress.open,
    high: Math.max(htfInProgress.high, ltfBar.high),
    low: Math.min(htfInProgress.low, ltfBar.low),
    close: ltfBar.close,
  };
}

// Anchor aleatorio entre `firstAvailableMs` y `nowMs - safeWindowMs`.
// El safe window evita escoger "ahora mismo" donde no hay historia suficiente
// hacia adelante para el replay.
export function pickRandomAnchor(firstAvailableMs, nowMs, safeWindowMs = 7 * 86_400_000) {
  const lo = firstAvailableMs;
  const hi = nowMs - safeWindowMs;
  if (hi <= lo) return lo;
  return Math.floor(lo + Math.random() * (hi - lo));
}

// Convierte una TF a milisegundos (1M devuelve 30d como aproximación —
// usar sólo para presupuestar tamaños de fetch, no para alineación).
export function timeframeMs(tf) {
  return TF_SECONDS[tf] * 1000;
}
