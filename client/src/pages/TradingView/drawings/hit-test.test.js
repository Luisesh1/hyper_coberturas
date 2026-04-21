import { describe, it, expect } from 'vitest';
import { hitTestDrawing, findHitDrawing, distPointToSegment, pointInRect } from './hit-test';

// Proyector mock: mapea directamente anchor.time → x y anchor.price → y
const project = (a) => {
  if (!a) return null;
  return {
    x: a.time != null ? Number(a.time) : null,
    y: a.price != null ? Number(a.price) : null,
  };
};

describe('hit-test helpers', () => {
  it('distPointToSegment mide correctamente puntos colineales', () => {
    // segmento de (0,0) a (10,0); punto en (5, 0) → dist 0
    expect(distPointToSegment(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    // punto en (5, 3) → dist 3
    expect(distPointToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    // punto antes del segmento (-5, 0) → dist 5 (al endpoint más cercano)
    expect(distPointToSegment(-5, 0, 0, 0, 10, 0)).toBeCloseTo(5);
  });

  it('pointInRect detecta interior y borde', () => {
    expect(pointInRect(5, 5, 0, 0, 10, 10)).toBe(true);
    expect(pointInRect(0, 0, 0, 0, 10, 10)).toBe(true);
    expect(pointInRect(-1, 5, 0, 0, 10, 10)).toBe(false);
  });
});

describe('hitTestDrawing', () => {
  it('trendline: hit cuando el click está sobre la línea (±5px)', () => {
    const line = {
      type: 'trendline',
      anchors: [{ time: 0, price: 0 }, { time: 100, price: 100 }],
      visible: true,
    };
    // Punto sobre la diagonal y=x
    expect(hitTestDrawing(line, 50, 50, project, 200)).toBe(true);
    // Punto a 3px de la diagonal (dentro de tolerancia 5)
    expect(hitTestDrawing(line, 50, 52, project, 200)).toBe(true);
    // Punto lejos
    expect(hitTestDrawing(line, 50, 80, project, 200)).toBe(false);
  });

  it('horizontal: hit en cualquier X al precio indicado', () => {
    const h = {
      type: 'horizontal',
      anchors: [{ price: 100 }],
      visible: true,
    };
    expect(hitTestDrawing(h, 50, 100, project, 500)).toBe(true);
    expect(hitTestDrawing(h, 400, 103, project, 500)).toBe(true);
    expect(hitTestDrawing(h, 50, 120, project, 500)).toBe(false);
  });

  it('rectangle: hit en interior y borde', () => {
    const r = {
      type: 'rectangle',
      anchors: [{ time: 10, price: 10 }, { time: 50, price: 50 }],
      visible: true,
    };
    expect(hitTestDrawing(r, 30, 30, project, 200)).toBe(true); // interior
    expect(hitTestDrawing(r, 10, 30, project, 200)).toBe(true); // borde izq
    expect(hitTestDrawing(r, 0, 30, project, 200)).toBe(false); // fuera (10px del borde, > tolerancia 5)
  });

  it('fib: hit sobre la diagonal entre los dos anchors', () => {
    const f = {
      type: 'fib',
      anchors: [{ time: 0, price: 0 }, { time: 100, price: 100 }],
      visible: true,
    };
    expect(hitTestDrawing(f, 50, 50, project, 200)).toBe(true);
    expect(hitTestDrawing(f, 50, 80, project, 200)).toBe(false);
  });

  it('retorna false para dibujos invisibles', () => {
    const line = {
      type: 'trendline',
      anchors: [{ time: 0, price: 0 }, { time: 100, price: 100 }],
      visible: false,
    };
    expect(hitTestDrawing(line, 50, 50, project, 200)).toBe(false);
  });

  it('retorna false para tipo desconocido', () => {
    expect(hitTestDrawing({ type: 'unknown', anchors: [] }, 50, 50, project, 200)).toBe(false);
  });
});

describe('findHitDrawing', () => {
  it('elige el topmost (último en el array) cuando hay varios en el mismo punto', () => {
    const drawings = [
      { uid: 'a', type: 'horizontal', anchors: [{ price: 100 }], visible: true },
      { uid: 'b', type: 'horizontal', anchors: [{ price: 100 }], visible: true },
    ];
    const hit = findHitDrawing(drawings, 50, 100, project, 200);
    expect(hit.uid).toBe('b');
  });

  it('retorna null cuando no hay hit', () => {
    const drawings = [
      { uid: 'a', type: 'horizontal', anchors: [{ price: 100 }], visible: true },
    ];
    expect(findHitDrawing(drawings, 50, 200, project, 500)).toBeNull();
  });
});
