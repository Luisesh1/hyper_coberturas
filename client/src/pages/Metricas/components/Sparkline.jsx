/**
 * Curva minima en SVG. Existe para que la fila colapsada tenga forma sin
 * montar un chart de verdad: la pagina puede mostrar N tendencias y una sola
 * instancia de lightweight-charts, la de la fila abierta.
 */
const MAX_POINTS = 72;

/** Submuestreo por paso fijo, conservando siempre el ultimo punto. */
function downsample(values) {
  if (values.length <= MAX_POINTS) return values;
  const step = (values.length - 1) / (MAX_POINTS - 1);
  const out = [];
  for (let i = 0; i < MAX_POINTS - 1; i += 1) out.push(values[Math.round(i * step)]);
  out.push(values[values.length - 1]);
  return out;
}

export default function Sparkline({
  values,
  width = 108,
  height = 24,
  stroke = 'currentColor',
  strokeWidth = 1.6,
  fillId = null,
  stretch = false,
  ariaLabel,
}) {
  const points = downsample((values || []).filter((v) => Number.isFinite(v)));
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = strokeWidth;
  const usable = Math.max(height - pad * 2, 1);
  const stepX = width / (points.length - 1);
  const y = (v) => pad + usable - ((v - min) / span) * usable;

  const line = points
    .map((v, i) => `${i ? 'L' : 'M'}${(i * stepX).toFixed(2)} ${y(v).toFixed(2)}`)
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={stretch ? '100%' : width}
      height={height}
      preserveAspectRatio={stretch ? 'none' : 'xMidYMid meet'}
      role="img"
      aria-label={ariaLabel}
      focusable="false"
    >
      {fillId && (
        <>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${fillId})`} />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        vectorEffect={stretch ? 'non-scaling-stroke' : undefined}
      />
    </svg>
  );
}
