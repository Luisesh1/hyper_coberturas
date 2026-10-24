import { formatUsdt } from '../../strategies/common/format';
import styles from './visual.module.css';

/**
 * Mini curva del P&L acumulado (pnlSeries del listado, 30 días). El color
 * sigue el signo del último valor. Con menos de dos puntos no pinta nada.
 */
export default function Sparkline({ values = [], width = 84, height = 26, label = 'P&L 30 días' }) {
  const v = (Array.isArray(values) ? values : []).filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const min = Math.min(...v, 0);
  const max = Math.max(...v, 0);
  const span = max - min || 1;
  const pad = 3;
  const pts = v.map((n, i) => [
    (i / (v.length - 1)) * width,
    pad + ((max - n) / span) * (height - 2 * pad),
  ]);
  const last = v[v.length - 1];
  const tone = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  const [cx, cy] = pts[pts.length - 1];
  return (
    <svg
      className={`${styles.spark} ${styles[`spark_${tone}`]}`}
      width={width}
      height={height}
      viewBox={`-3 0 ${width + 6} ${height}`}
      role="img"
      aria-label={`${label}: ${formatUsdt(last, { sign: true })}`}
    >
      <polyline fill="none" strokeWidth="1.6" strokeLinejoin="round" points={pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ')} />
      <circle cx={cx.toFixed(1)} cy={cy.toFixed(1)} r="2.4" />
    </svg>
  );
}
