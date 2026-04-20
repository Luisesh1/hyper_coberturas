import { useEffect, useState } from 'react';
import { formatRelative, formatAbsolute } from '../../utils/formatters';

/**
 * RelativeTime — muestra una fecha como "hace 3m" con tooltip absoluto en hover.
 *
 * Props:
 *   - timestamp: number (ms por defecto; segundos si `inSeconds={true}`)
 *   - inSeconds: boolean — true si el timestamp viene en segundos (UNIX)
 *   - autoRefreshMs: cada cuánto re-renderiza para mantener el texto fresco.
 *       default: 30s si la fecha tiene < 1h de edad, 5min si es más vieja.
 *   - className: pasa al <time>
 *   - prefix/suffix: texto opcional alrededor del relativo
 */
export function RelativeTime({
  timestamp,
  inSeconds = false,
  autoRefreshMs,
  className,
  prefix,
  suffix,
}) {
  const ms = timestamp != null
    ? (inSeconds ? Number(timestamp) * 1000 : Number(timestamp))
    : null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!ms) return undefined;
    // Auto-refresh dinámico: más frecuente para fechas recientes.
    const ageMs = Date.now() - ms;
    const interval = Number.isFinite(autoRefreshMs)
      ? autoRefreshMs
      : (ageMs < 3_600_000 ? 30_000 : 300_000);
    const id = setInterval(() => setTick((v) => v + 1), interval);
    return () => clearInterval(id);
  }, [ms, autoRefreshMs]);

  if (!ms) return <span className={className}>—</span>;

  const relative = formatRelative(ms);
  const absolute = formatAbsolute(ms);

  return (
    <time
      className={className}
      dateTime={new Date(ms).toISOString()}
      title={absolute}
    >
      {prefix}{relative}{suffix}
    </time>
  );
}
