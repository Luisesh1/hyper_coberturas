// Funciones de dibujo puras — reciben ctx del canvas, el drawing, y `project`
// (convierte { time, price } → { x, y } en px; si time/price no es convertible
// devuelve null y se omite). Diseñadas para ser testeables con ctx mock.

import { FIB_LEVELS } from './catalog';

const DASH_STYLE = {
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
};

function applyStroke(ctx, style = {}) {
  ctx.strokeStyle = style.color || '#94a3b8';
  ctx.lineWidth = style.lineWidth || 1;
  ctx.setLineDash(DASH_STYLE[style.lineStyle] || DASH_STYLE.solid);
}

function strokeLine(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawHandle(ctx, x, y, highlighted = false) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = highlighted ? '#ffffff' : '#0f1114';
  ctx.strokeStyle = highlighted ? '#6366f1' : '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, text, x, y, { bg = 'rgba(30,34,42,0.9)', fg = '#e2e8f0' } = {}) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  const padding = 4;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padding * 2;
  const h = 16;
  ctx.fillStyle = bg;
  ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padding, y - h / 2);
  ctx.restore();
}

// ------------------------------------------------------------------
// Renderers por tipo
// ------------------------------------------------------------------

function renderTrendline(ctx, drawing, project, opts) {
  const [a, b] = drawing.anchors;
  const pa = project(a);
  const pb = project(b);
  if (!pa || !pb) return;
  ctx.save();
  applyStroke(ctx, drawing.style);
  strokeLine(ctx, pa.x, pa.y, pb.x, pb.y);
  if (opts.selected) {
    drawHandle(ctx, pa.x, pa.y, true);
    drawHandle(ctx, pb.x, pb.y, true);
  }
  ctx.restore();
}

function renderHorizontal(ctx, drawing, project, opts) {
  const [a] = drawing.anchors;
  const p = project(a);
  if (!p || !Number.isFinite(p.y)) return;
  ctx.save();
  applyStroke(ctx, drawing.style);
  strokeLine(ctx, 0, p.y, opts.width, p.y);
  drawLabel(ctx, Number(a.price).toLocaleString('en-US', { maximumFractionDigits: 6 }), opts.width - 80, p.y);
  ctx.restore();
}

function renderRectangle(ctx, drawing, project, opts) {
  const [a, b] = drawing.anchors;
  const pa = project(a);
  const pb = project(b);
  if (!pa || !pb) return;
  const x = Math.min(pa.x, pb.x);
  const y = Math.min(pa.y, pb.y);
  const w = Math.abs(pb.x - pa.x);
  const h = Math.abs(pb.y - pa.y);
  ctx.save();
  applyStroke(ctx, drawing.style);
  const color = drawing.style?.color || '#a855f7';
  const opacity = drawing.style?.fillOpacity ?? 0.15;
  ctx.fillStyle = hexToRgba(color, opacity);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  if (opts.selected) {
    drawHandle(ctx, pa.x, pa.y, true);
    drawHandle(ctx, pb.x, pb.y, true);
  }
  ctx.restore();
}

function renderFib(ctx, drawing, project, opts) {
  const [a, b] = drawing.anchors;
  const pa = project(a);
  const pb = project(b);
  if (!pa || !pb) return;
  const x1 = Math.min(pa.x, pb.x);
  const x2 = Math.max(pa.x, pb.x);
  const priceHigh = Math.max(a.price, b.price);
  const priceLow = Math.min(a.price, b.price);
  const range = priceHigh - priceLow;

  ctx.save();
  // Línea principal entre los dos anchors
  applyStroke(ctx, { ...drawing.style, lineStyle: 'dashed', color: drawing.style?.color || '#14b8a6', lineWidth: 1 });
  strokeLine(ctx, pa.x, pa.y, pb.x, pb.y);

  for (const { level, color } of FIB_LEVELS) {
    const price = priceHigh - range * level;
    const yResult = project({ time: a.time, price });
    const y = yResult?.y;
    if (!Number.isFinite(y)) continue;
    applyStroke(ctx, { color, lineWidth: 1, lineStyle: 'solid' });
    strokeLine(ctx, x1, y, x2, y);
    drawLabel(
      ctx,
      `${(level * 100).toFixed(1)}%  ${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`,
      x2 + 4,
      y + 6,
      { bg: hexToRgba(color, 0.85), fg: '#0f1114' },
    );
  }
  if (opts.selected) {
    drawHandle(ctx, pa.x, pa.y, true);
    drawHandle(ctx, pb.x, pb.y, true);
  }
  ctx.restore();
}

function renderRuler(ctx, drawing, project, opts) {
  const [a, b] = drawing.anchors;
  const pa = project(a);
  const pb = project(b);
  if (!pa || !pb) return;

  const diffPrice = b.price - a.price;
  const diffPct = a.price !== 0 ? (diffPrice / a.price) * 100 : 0;
  const diffTime = Math.abs(b.time - a.time);
  const bars = opts.secondsPerBar ? Math.round(diffTime / opts.secondsPerBar) : null;

  const isUp = diffPrice >= 0;
  const color = isUp ? '#10b981' : '#ef4444';

  ctx.save();
  // Rectángulo translúcido
  const x = Math.min(pa.x, pb.x);
  const y = Math.min(pa.y, pb.y);
  const w = Math.abs(pb.x - pa.x);
  const h = Math.abs(pb.y - pa.y);
  ctx.fillStyle = hexToRgba(color, 0.12);
  ctx.fillRect(x, y, w, h);

  applyStroke(ctx, { color, lineWidth: 1, lineStyle: 'dashed' });
  ctx.strokeRect(x, y, w, h);

  // Línea entre los dos anchors
  applyStroke(ctx, { color, lineWidth: 1, lineStyle: 'solid' });
  strokeLine(ctx, pa.x, pa.y, pb.x, pb.y);

  // HUD embebido
  const hms = formatDelta(diffTime * 1000);
  const line1 = `${isUp ? '+' : ''}${diffPrice.toFixed(4)}  (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%)`;
  const line2 = `${hms}${bars != null ? ` · ${bars} bars` : ''}`;

  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  const textW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16;
  const boxW = textW;
  const boxH = 36;
  const boxX = pb.x + 8;
  const boxY = pb.y - boxH / 2;

  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(15,17,20,0.92)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(line1, boxX + 8, boxY + 4);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(line2, boxX + 8, boxY + 20);

  drawHandle(ctx, pa.x, pa.y);
  drawHandle(ctx, pb.x, pb.y);
  ctx.restore();
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(148,163,184,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function formatDelta(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------

const RENDERERS = {
  trendline: renderTrendline,
  horizontal: renderHorizontal,
  rectangle: renderRectangle,
  fib: renderFib,
  ruler: renderRuler,
};

export function renderDrawing(ctx, drawing, project, opts = {}) {
  const fn = RENDERERS[drawing?.type];
  if (!fn) return;
  if (!Array.isArray(drawing.anchors) || drawing.anchors.length === 0) return;
  // Para tipos que requieren 2 anchors, solo dibuja si ambos existen
  if (['trendline', 'rectangle', 'fib', 'ruler'].includes(drawing.type) && drawing.anchors.length < 2) return;
  fn(ctx, drawing, project, opts);
}

export { hexToRgba, formatDelta };
