import { useMemo, useState } from 'react';
import styles from './LineChart.module.css';

const VIEW_W = 1000;
const PAD_Y = 10;

// Gráfico de líneas ligero en SVG (sin lightweight-charts: son curvas de
// decenas o cientos de puntos y no necesitan zoom). El SVG se estira al
// ancho del contenedor con trazos que no escalan; los textos, el punto y el
// tooltip son HTML encima para que no se deformen.
//
// series: [{ key, label, values: (number|null)[], variant: 'primary'|'live'|'muted', dashed }]
export default function LineChart({
  times = [],
  series = [],
  height = 180,
  markers = [],
  formatValue = (v) => String(v),
  formatTime = (t) => String(t),
  ariaLabel,
  zeroLine = false,
  emptyText = 'Sin datos todavía',
}) {
  const [hover, setHover] = useState(null);
  const n = times.length;

  const scale = useMemo(() => {
    const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    if (!all.length) return null;
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    return { min: min - span * 0.04, max: max + span * 0.04 };
  }, [series, zeroLine]);

  if (!n || !scale) {
    return <div className={styles.empty} style={{ height }}>{emptyText}</div>;
  }

  const xAt = (i) => (n > 1 ? (i / (n - 1)) * VIEW_W : VIEW_W / 2);
  const yAt = (v) => PAD_Y + ((scale.max - v) / (scale.max - scale.min)) * (height - 2 * PAD_Y);
  const xPct = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);

  const pathFor = (values) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)} `;
      pen = true;
    });
    return d.trim();
  };

  const ticks = [scale.max, (scale.max + scale.min) / 2, scale.min];

  const indexFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return null;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return Math.round(frac * (n - 1));
  };

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const base = hover ?? (e.key === 'ArrowLeft' ? n : -1);
    setHover(Math.min(n - 1, Math.max(0, base + (e.key === 'ArrowRight' ? 1 : -1))));
  };

  const hoverLeftPct = hover !== null ? xPct(hover) : 0;

  return (
    <div className={styles.wrap}>
      <div
        className={styles.plot}
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={(e) => setHover(indexFromEvent(e))}
        onPointerDown={(e) => setHover(indexFromEvent(e))}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <svg
          className={styles.svg}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {ticks.map((t, i) => (
            <line key={i} x1="0" x2={VIEW_W} y1={yAt(t)} y2={yAt(t)} className={styles.grid} vectorEffect="non-scaling-stroke" />
          ))}
          {zeroLine && scale.min < 0 && scale.max > 0 && (
            <line x1="0" x2={VIEW_W} y1={yAt(0)} y2={yAt(0)} className={styles.zero} vectorEffect="non-scaling-stroke" />
          )}
          {markers.map((m) => (
            <line
              key={`m-${m.index}`}
              x1={xAt(m.index)}
              x2={xAt(m.index)}
              y1="0"
              y2={height}
              className={styles.marker}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map((s) => (
            <path
              key={s.key}
              d={pathFor(s.values)}
              className={`${styles.line} ${styles[`line_${s.variant || 'primary'}`]}`}
              strokeDasharray={s.dashed ? '6 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {ticks.map((t, i) => (
          <span key={i} className={styles.tick} style={{ top: yAt(t) }}>{formatValue(t)}</span>
        ))}
        {markers.map((m) => (
          <span
            key={`ml-${m.index}`}
            className={`${styles.markerLabel} ${xPct(m.index) > 70 ? styles.markerLabelLeft : ''}`}
            style={{ left: `${xPct(m.index)}%` }}
          >
            {m.label}
          </span>
        ))}

        {hover !== null && (
          <>
            <span className={styles.crosshair} style={{ left: `${hoverLeftPct}%` }} aria-hidden="true" />
            {series.map((s) => (Number.isFinite(s.values[hover]) ? (
              <span
                key={s.key}
                className={`${styles.dot} ${styles[`dot_${s.variant || 'primary'}`]}`}
                style={{ left: `${hoverLeftPct}%`, top: yAt(s.values[hover]) }}
                aria-hidden="true"
              />
            ) : null))}
            <div
              className={`${styles.tooltip} ${hoverLeftPct > 60 ? styles.tooltipLeft : ''}`}
              style={{ left: `${hoverLeftPct}%` }}
              role="status"
            >
              <span className={styles.tooltipTime}>{formatTime(times[hover])}</span>
              {series.map((s) => (
                <span key={s.key} className={styles.tooltipRow}>
                  <span className={`${styles.swatch} ${styles[`swatch_${s.variant || 'primary'}`]} ${s.dashed ? styles.swatchDashed : ''}`} />
                  <span className={styles.tooltipLabel}>{s.label}</span>
                  <span className={styles.tooltipValue}>{Number.isFinite(s.values[hover]) ? formatValue(s.values[hover]) : '—'}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>{formatTime(times[0])}</span>
        {n > 1 && <span>{formatTime(times[n - 1])}</span>}
      </div>
    </div>
  );
}

// Leyenda: siempre presente con ≥2 series; la línea discontinua repite la
// identidad sin depender sólo del color.
export function ChartLegend({ items }) {
  return (
    <div className={styles.legend}>
      {items.map((it) => (
        <span key={it.label} className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles[`swatch_${it.variant || 'primary'}`]} ${it.dashed ? styles.swatchDashed : ''}`} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </div>
  );
}
