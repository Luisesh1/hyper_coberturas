import { describe, it, expect, vi } from 'vitest';
import { renderDrawing, hexToRgba, formatDelta } from './renderer';

function makeMockCtx() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    setLineDash: record('setLineDash'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    arc: record('arc'),
    fill: record('fill'),
    measureText: () => ({ width: 50 }),
    set strokeStyle(v) { calls.push(['strokeStyle', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set lineWidth(v) { calls.push(['lineWidth', v]); },
    set font(v) { calls.push(['font', v]); },
    set textBaseline(v) { calls.push(['textBaseline', v]); },
  };
}

const identityProject = (a) => {
  if (!a) return null;
  return { x: a.time ?? 0, y: a.price ?? 0 };
};

describe('renderDrawing', () => {
  it('trendline: dibuja una línea entre los dos anchors', () => {
    const ctx = makeMockCtx();
    renderDrawing(
      ctx,
      { type: 'trendline', anchors: [{ time: 10, price: 20 }, { time: 50, price: 80 }], style: { color: '#ff0000', lineWidth: 2 } },
      identityProject,
      { width: 500, height: 300 },
    );
    const moveTo = ctx.calls.find((c) => c[0] === 'moveTo');
    const lineTo = ctx.calls.find((c) => c[0] === 'lineTo');
    expect(moveTo).toEqual(['moveTo', 10, 20]);
    expect(lineTo).toEqual(['lineTo', 50, 80]);
    expect(ctx.calls.some((c) => c[0] === 'strokeStyle' && c[1] === '#ff0000')).toBe(true);
  });

  it('horizontal: dibuja línea full-width al price proyectado', () => {
    const ctx = makeMockCtx();
    renderDrawing(
      ctx,
      { type: 'horizontal', anchors: [{ price: 100 }], style: { color: '#00ff00' } },
      identityProject,
      { width: 500, height: 300 },
    );
    const moveTo = ctx.calls.find((c) => c[0] === 'moveTo');
    const lineTo = ctx.calls.find((c) => c[0] === 'lineTo');
    expect(moveTo[2]).toBe(100); // y = price
    expect(moveTo[1]).toBe(0);   // x = 0 (full-width)
    expect(lineTo[1]).toBe(500); // x = width
  });

  it('rectangle: llena y dibuja borde entre las dos esquinas', () => {
    const ctx = makeMockCtx();
    renderDrawing(
      ctx,
      { type: 'rectangle', anchors: [{ time: 10, price: 20 }, { time: 50, price: 80 }], style: { color: '#ff00ff', fillOpacity: 0.3 } },
      identityProject,
      { width: 500, height: 300 },
    );
    expect(ctx.calls.some((c) => c[0] === 'fillRect')).toBe(true);
    expect(ctx.calls.some((c) => c[0] === 'strokeRect')).toBe(true);
  });

  it('fib: dibuja 7 niveles de Fibonacci + diagonal', () => {
    const ctx = makeMockCtx();
    renderDrawing(
      ctx,
      { type: 'fib', anchors: [{ time: 0, price: 100 }, { time: 100, price: 200 }], style: {} },
      identityProject,
      { width: 500, height: 300 },
    );
    // Debe haber al menos 8 líneas trazadas (diagonal + 7 niveles)
    const strokeCount = ctx.calls.filter((c) => c[0] === 'stroke').length;
    expect(strokeCount).toBeGreaterThanOrEqual(8);
  });

  it('ruler: dibuja rectángulo de medición con HUD', () => {
    const ctx = makeMockCtx();
    renderDrawing(
      ctx,
      { type: 'ruler', anchors: [{ time: 10, price: 20 }, { time: 50, price: 80 }] },
      identityProject,
      { width: 500, height: 300, secondsPerBar: 900 },
    );
    // El HUD escribe al menos dos fillText (línea 1 y línea 2)
    const fillTextCalls = ctx.calls.filter((c) => c[0] === 'fillText');
    expect(fillTextCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('no dibuja cuando no hay anchors', () => {
    const ctx = makeMockCtx();
    renderDrawing(ctx, { type: 'trendline', anchors: [] }, identityProject, { width: 500 });
    expect(ctx.calls.length).toBe(0);
  });

  it('no dibuja para tipos desconocidos', () => {
    const ctx = makeMockCtx();
    renderDrawing(ctx, { type: 'unknown', anchors: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }, identityProject, { width: 500 });
    expect(ctx.calls.length).toBe(0);
  });
});

describe('helpers', () => {
  it('hexToRgba convierte hex correctamente', () => {
    expect(hexToRgba('#ff0000', 1)).toBe('rgba(255,0,0,1)');
    expect(hexToRgba('#00ff00', 0.5)).toBe('rgba(0,255,0,0.5)');
  });

  it('hexToRgba devuelve fallback gris si el color es inválido', () => {
    expect(hexToRgba('invalid', 0.5)).toBe('rgba(148,163,184,0.5)');
    expect(hexToRgba(null, 1)).toBe('rgba(148,163,184,1)');
  });

  it('formatDelta formatea segundos, minutos, horas, días', () => {
    expect(formatDelta(30_000)).toBe('30s');
    expect(formatDelta(90_000)).toBe('1m 30s');
    expect(formatDelta(3_900_000)).toBe('1h 5m');
    expect(formatDelta(90_000_000)).toBe('1d 1h');
  });
});
