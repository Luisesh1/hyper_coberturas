import { describe, it, expect } from 'vitest';
import { computeBalancedNotionalUsd, computeDeltaNotionalUsd, computeHedgeConsequence } from './hedgeNotional';

// Los valores esperados salen de la fórmula cerrada del delta de un LP v3:
//   fracVolátil = (√P − P/√Pb) / (2√P − P/√Pb − √Pa)
// El delta en unidades de token es exactamente la cantidad de token volátil
// que la posición mantiene, así que el notional a cubrir es el valor USD de
// esa pata. Ver docs/superpowers/specs/2026-08-17-notional-auto-delta-design.md
describe('computeDeltaNotionalUsd', () => {
  describe('precio centrado en el rango', () => {
    it('un rango ±10% deja ~47.6% del capital en el token volátil', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 100,
        rangeLowerPrice: 90,
        rangeUpperPrice: 110,
      });

      expect(notional).toBeCloseTo(110 * 0.476, 1);
    });

    it('un rango ±2% se acerca al 50% que asumía la heurística vieja', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 100,
        rangeLowerPrice: 98,
        rangeUpperPrice: 102,
      });

      expect(notional).toBeCloseTo(110 * 0.495, 1);
    });

    it('un rango ±50% baja al 38.5%: la heurística capital/2 sobre-cubre', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 100,
        rangeLowerPrice: 50,
        rangeUpperPrice: 150,
      });

      expect(notional).toBeCloseTo(110 * 0.385, 1);
    });
  });

  describe('precio descentrado — el caso que justifica el auto', () => {
    it('pegado al borde inferior casi todo el LP es token volátil (88.7%)', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 92,
        rangeLowerPrice: 90,
        rangeUpperPrice: 110,
      });

      expect(notional).toBeCloseTo(110 * 0.887, 1);
    });

    it('pegado al borde superior casi no queda volátil (9.5%)', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 108,
        rangeLowerPrice: 90,
        rangeUpperPrice: 110,
      });

      expect(notional).toBeCloseTo(110 * 0.095, 1);
    });
  });

  describe('fuera de rango', () => {
    it('por debajo del borde inferior el LP es 100% token volátil', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 80,
        rangeLowerPrice: 90,
        rangeUpperPrice: 110,
      });

      expect(notional).toBe(110);
    });

    it('por encima del borde superior no queda exposición que cubrir', () => {
      const notional = computeDeltaNotionalUsd({
        capitalUsd: 110,
        currentPrice: 120,
        rangeLowerPrice: 90,
        rangeUpperPrice: 110,
      });

      expect(notional).toBe(0);
    });
  });

  describe('entradas inválidas devuelven null para que el llamador use el fallback', () => {
    it('null si falta el precio actual', () => {
      expect(computeDeltaNotionalUsd({
        capitalUsd: 110, currentPrice: null, rangeLowerPrice: 90, rangeUpperPrice: 110,
      })).toBeNull();
    });

    it('null si el borde superior no supera al inferior', () => {
      expect(computeDeltaNotionalUsd({
        capitalUsd: 110, currentPrice: 100, rangeLowerPrice: 110, rangeUpperPrice: 110,
      })).toBeNull();
    });

    it('null si el capital no es un número positivo', () => {
      expect(computeDeltaNotionalUsd({
        capitalUsd: 0, currentPrice: 100, rangeLowerPrice: 90, rangeUpperPrice: 110,
      })).toBeNull();
    });

    it('null si algún precio es negativo', () => {
      expect(computeDeltaNotionalUsd({
        capitalUsd: 110, currentPrice: 100, rangeLowerPrice: -1, rangeUpperPrice: 110,
      })).toBeNull();
    });
  });
});

describe('computeHedgeConsequence', () => {
  it('el margen requerido es el notional dividido por el leverage', () => {
    const result = computeHedgeConsequence({ notionalUsd: 97.57, leverage: 10 });
    expect(result.requiredMarginUsd).toBeCloseTo(9.757, 3);
  });

  it('a mayor leverage, la liquidación queda más cerca', () => {
    expect(computeHedgeConsequence({ notionalUsd: 100, leverage: 5 }).liquidationMovePct).toBe('20.0');
    expect(computeHedgeConsequence({ notionalUsd: 100, leverage: 20 }).liquidationMovePct).toBe('5.0');
  });

  it('devuelve null sin notional o sin leverage utilizables', () => {
    expect(computeHedgeConsequence({ notionalUsd: 0, leverage: 10 })).toBeNull();
    expect(computeHedgeConsequence({ notionalUsd: 100, leverage: 0 })).toBeNull();
    expect(computeHedgeConsequence({ notionalUsd: 100, leverage: NaN })).toBeNull();
  });
});

// Espejo de `balancedQty` del servidor (terminal-range-policy.service.js): el
// short con que abre terminal_range_v1 es la secante (V(b) − V(a)) / (b − a)
// del valor del LP entre bordes. Con L = 1, V(P) = 2√P − P/√b − √a en rango.
function secantFraction(P, a, b) {
  const V = (p) => {
    if (p <= a) return p * (1 / Math.sqrt(a) - 1 / Math.sqrt(b));
    if (p >= b) return Math.sqrt(b) - Math.sqrt(a);
    return 2 * Math.sqrt(p) - p / Math.sqrt(b) - Math.sqrt(a);
  };
  return (((V(b) - V(a)) / (b - a)) * P) / V(P);
}

describe('computeBalancedNotionalUsd', () => {
  it('dimensiona la entrada balanceada desde el valor del LP, no desde el pico', () => {
    const notional = computeBalancedNotionalUsd({
      capitalUsd: 510, currentPrice: 100, rangeLowerPrice: 95, rangeUpperPrice: 105,
    });
    expect(notional).toBeCloseTo(510 * secantFraction(100, 95, 105), 6);
    // ~49% del LP con el precio centrado: nunca el 1,5x del pico ($765).
    expect(notional).toBeGreaterThan(240);
    expect(notional).toBeLessThan(260);
  });

  it('con el precio lejos del centro sigue la secante, no el delta', () => {
    const notional = computeBalancedNotionalUsd({
      capitalUsd: 1000, currentPrice: 92, rangeLowerPrice: 90, rangeUpperPrice: 110,
    });
    expect(notional).toBeCloseTo(1000 * secantFraction(92, 90, 110), 6);
    const delta = computeDeltaNotionalUsd({
      capitalUsd: 1000, currentPrice: 92, rangeLowerPrice: 90, rangeUpperPrice: 110,
    });
    expect(Math.abs(notional - delta)).toBeGreaterThan(1);
  });

  it('devuelve null sin capital o sin rango valido', () => {
    expect(computeBalancedNotionalUsd({ capitalUsd: 0, currentPrice: 100, rangeLowerPrice: 90, rangeUpperPrice: 110 })).toBeNull();
    expect(computeBalancedNotionalUsd({ capitalUsd: 100, currentPrice: 100, rangeLowerPrice: 110, rangeUpperPrice: 90 })).toBeNull();
  });
});
