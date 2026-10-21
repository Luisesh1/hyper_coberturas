import { useEffect, useRef, useState } from 'react';
import { AreaSeries, ColorType, CrosshairMode, createChart } from 'lightweight-charts';
import { fmtDateTime, fmtUsd } from '../lib/format';
import { sourceLabel } from '../lib/labels';
import styles from '../MetricasPage.module.css';

export const LAYER_COLORS = {
  tokens: '#a78bfa',
  lp: '#22c55e',
  hl: '#f59e0b',
};

// Apilado: cada capa se dibuja como area desde 0 hasta su tope acumulado y
// las de abajo tapan a las de arriba. Orden de dibujo: la mas alta primero.
const LAYERS = [
  { key: 'hl', label: 'Hyperliquid', color: LAYER_COLORS.hl, top: (p) => p.tokens + p.lp + p.hl },
  { key: 'lp', label: 'LPs', color: LAYER_COLORS.lp, top: (p) => p.tokens + p.lp },
  { key: 'tokens', label: 'Tokens', color: LAYER_COLORS.tokens, top: (p) => p.tokens },
];

// Las capas se tapan entre si: con relleno translucido sus colores se
// mezclarian (morado sobre naranja da gris). Se rellenan opacas, con el color
// de la capa mezclado con el fondo de la tarjeta para que no griten.
const CARD_BG = [19, 23, 34];

function mutedFill(hex, weight) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * weight + CARD_BG[i] * (1 - weight)));
  return `rgb(${mixed.join(', ')})`;
}

function toChartTime(ms) {
  return Math.floor(Number(ms) / 1000);
}

/** Valor total de una wallet en el tiempo, apilado en tokens / LPs / HL. */
export default function WalletValueChart({ points }) {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const [stacked, setStacked] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || points.length === 0) return undefined;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#cbd5e1',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { vertTouchDrag: false },
    });

    if (stacked) {
      for (const layer of LAYERS) {
        const series = chart.addSeries(AreaSeries, {
          lineColor: layer.color,
          topColor: mutedFill(layer.color, 0.6),
          bottomColor: mutedFill(layer.color, 0.5),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        series.setData(points.map((p) => ({ time: toChartTime(p.t), value: layer.top(p) })));
      }
    } else {
      const series = chart.addSeries(AreaSeries, {
        lineColor: '#38bdf8',
        topColor: 'rgba(56, 189, 248, 0.28)',
        bottomColor: 'rgba(56, 189, 248, 0.02)',
        lineWidth: 2,
      });
      series.setData(points.map((p) => ({ time: toChartTime(p.t), value: p.total })));
    }
    chart.timeScale().fitContent();

    const byTime = new Map(points.map((p) => [toChartTime(p.t), p]));
    const tooltipEl = tooltipRef.current;
    const onMove = (param) => {
      if (!tooltipEl) return;
      const point = param.time != null ? byTime.get(Number(param.time)) : null;
      if (!param.point || !point) {
        tooltipEl.style.display = 'none';
        return;
      }
      const rows = [...LAYERS].reverse().map((l) => `
        <div class="${styles.tooltipRow}">
          <span><span class="${styles.legendSwatch}" style="background:${l.color}"></span>${l.label}</span>
          <strong>${fmtUsd(point[l.key])}</strong>
        </div>`).join('');
      const partial = point.partial
        ? `<div class="${styles.tooltipPartial}">Parcial: ${(point.stale || []).map((s) => sourceLabel(s.key)).join(', ')} con su último valor</div>`
        : '';
      tooltipEl.innerHTML = `
        <div class="${styles.tooltipDate}">${fmtDateTime(point.t)}</div>
        <div class="${styles.tooltipRow}"><span>Total</span><strong>${fmtUsd(point.total)}</strong></div>
        ${rows}${partial}`;
      tooltipEl.style.display = 'block';
      const w = tooltipEl.offsetWidth || 180;
      const h = tooltipEl.offsetHeight || 100;
      let left = param.point.x + 12;
      if (left + w > container.clientWidth) left = Math.max(4, param.point.x - w - 12);
      let top = param.point.y + 12;
      if (top + h > container.clientHeight) top = Math.max(4, param.point.y - h - 12);
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${top}px`;
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      if (tooltipEl) tooltipEl.style.display = 'none';
    };
  }, [points, stacked]);

  return (
    <div className={styles.chartBlock}>
      <div className={styles.legend}>
        <div className={styles.segmented} role="group" aria-label="Vista de la gráfica">
          <button type="button" aria-pressed={stacked} className={stacked ? styles.segmentedOn : ''} onClick={() => setStacked(true)}>
            Desglose
          </button>
          <button type="button" aria-pressed={!stacked} className={!stacked ? styles.segmentedOn : ''} onClick={() => setStacked(false)}>
            Total
          </button>
        </div>
        {stacked && [...LAYERS].reverse().map((l) => (
          <span key={l.key} className={styles.legendStatic}>
            <span className={styles.legendSwatch} style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      <div className={styles.chartContainer} ref={containerRef}>
        <div ref={tooltipRef} className={styles.chartTooltip} style={{ display: 'none' }} />
        {points.length === 0 && (
          <div className={styles.empty}>
            Aún no hay puntos en este rango. Se captura uno cada hora en punto.
          </div>
        )}
      </div>
    </div>
  );
}
