import { OVERLAY_TF_MS, withAlpha } from '../overlays/useChartOverlays.js';

// Distintos de los colores de overlays e indicadores por defecto.
export const ALERT_COLORS = ['#facc15', '#fb7185', '#4ade80', '#c084fc', '#fb923c', '#e2e8f0'];
export const MAX_ALERT_MARKERS = 6;

export function nextColor(items) {
  const used = new Set((items || []).map((i) => i.color));
  return ALERT_COLORS.find((c) => !used.has(c)) ?? ALERT_COLORS[0];
}

export function addAlert(items, alertId) {
  if (items.some((i) => i.alertId === alertId) || items.length >= MAX_ALERT_MARKERS) return items;
  return [...items, { alertId, color: nextColor(items), hidden: false }];
}
export const removeAlert = (items, alertId) => items.filter((i) => i.alertId !== alertId);
export const toggleAlertHidden = (items, alertId) =>
  items.map((i) => (i.alertId === alertId ? { ...i, hidden: !i.hidden } : i));
export const setAlertColor = (items, alertId, color) =>
  items.map((i) => (i.alertId === alertId ? { ...i, color } : i));

// Vela del gráfico (time en s) que contiene evalTime − 1 ms: la última con open ≤ evalTime − 1.
// Null si cae antes de la primera vela o después del cierre de la última.
export function chartBucketSec(evalTimeMs, chartTf, chartCandles) {
  const tfMs = OVERLAY_TF_MS[chartTf];
  if (!tfMs || !Number.isFinite(evalTimeMs) || !chartCandles?.length) return null;
  const target = evalTimeMs - 1;
  let lo = 0;
  let hi = chartCandles.length - 1;
  if (target < chartCandles[0].time) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chartCandles[mid].time <= target) lo = mid; else hi = mid - 1;
  }
  const last = chartCandles[lo];
  if (lo === chartCandles.length - 1 && target >= last.time + tfMs) return null;
  return last.time / 1000;
}

const STYLE = {
  bullish: { position: 'belowBar', shape: 'arrowUp' },
  bearish: { position: 'aboveBar', shape: 'arrowDown' },
  neutral: { position: 'aboveBar', shape: 'circle' },
};

export function buildMarkers({ eventsByAlert, items, alertsById, chartTf, chartCandles, cutoffMs = Infinity }) {
  const out = [];
  for (const item of items || []) {
    if (item.hidden) continue;
    const buckets = new Map();
    for (const e of eventsByAlert?.[item.alertId] || []) {
      if (e.evalTime > cutoffMs) continue;
      const sec = chartBucketSec(e.evalTime, chartTf, chartCandles);
      if (sec == null) continue;
      if (!buckets.has(sec)) buckets.set(sec, []);
      buckets.get(sec).push(e);
    }
    const style = STYLE[alertsById?.[item.alertId]?.direction] ?? STYLE.neutral;
    for (const [sec, evs] of buckets) {
      out.push({
        time: sec,
        ...style,
        color: evs.every((e) => e.suppressed) ? withAlpha(item.color, 0.35) : item.color,
        text: evs.length > 1 ? `×${evs.length}` : '',
        id: `${item.alertId}:${sec}`,
      });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

export function eventsInBucket(eventsByAlert, items, chartTf, chartCandles, bucketSec, cutoffMs = Infinity) {
  const out = [];
  for (const item of items || []) {
    if (item.hidden) continue;
    for (const event of eventsByAlert?.[item.alertId] || []) {
      if (event.evalTime > cutoffMs) continue;
      if (chartBucketSec(event.evalTime, chartTf, chartCandles) === bucketSec) out.push({ alertId: item.alertId, event });
    }
  }
  return out;
}

// Disparos efectivos (no suprimidos) por alerta, hasta el cutoff de replay.
export function countFirings(eventsByAlert, cutoffMs = Infinity) {
  const out = {};
  for (const [id, list] of Object.entries(eventsByAlert || {})) {
    out[id] = (list || []).filter((e) => !e.suppressed && e.evalTime <= cutoffMs).length;
  }
  return out;
}

// Rango a evaluar: de la primera vela del gráfico (ms) al cierre de la última.
export function alertRanges(chartCandles, chartTf) {
  const tfMs = OVERLAY_TF_MS[chartTf];
  if (!tfMs || !chartCandles?.length) return [];
  return [{ fromMs: chartCandles[0].time, toMs: chartCandles[chartCandles.length - 1].time + tfMs }];
}

// Instante actual del replay (fin de la sub-vela en curso); Infinity fuera de replay.
export function replayCutoffMs(replay) {
  if (!replay?.active) return Infinity;
  const ltf = replay.progress?.ltfTime;
  if (ltf == null) return replay.anchor ?? Infinity;
  return ltf + (OVERLAY_TF_MS[replay.subTf] || 0);
}

// Eventos dibujables (items visibles, ≤ cutoff, dentro de alguna vela) con su vela, en orden temporal.
export function markerTimeline(eventsByAlert, items, chartTf, chartCandles, cutoffMs = Infinity) {
  const out = [];
  (items || []).forEach((item, order) => {
    if (item.hidden) return;
    for (const event of eventsByAlert?.[item.alertId] || []) {
      if (event.evalTime > cutoffMs) continue;
      const sec = chartBucketSec(event.evalTime, chartTf, chartCandles);
      if (sec != null) out.push({ alertId: item.alertId, event, sec, order });
    }
  });
  out.sort((x, y) => x.event.evalTime - y.event.evalTime || x.order - y.order);
  return out.map(({ order, ...rest }) => rest); // eslint-disable-line no-unused-vars
}
