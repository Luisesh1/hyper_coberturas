import { describe, expect, it } from 'vitest';
import { getRangeBarData } from './pool-helpers';

const pool = { rangeLowerPrice: 2581.2, rangeUpperPrice: 2810.19, priceCurrent: 2708.11 };

describe('getRangeBarData', () => {
  it('sin precio de apertura no pinta el pin de apertura', () => {
    // Regresion del orquestador #64: priceAtOpen null salia como precio 0,
    // pegado al borde izquierdo y con «—».
    expect(getRangeBarData({ ...pool, priceAtOpen: null }).openPct).toBeNull();
    expect(getRangeBarData({ ...pool }).openPct).toBeNull();
  });

  it('con precio de apertura lo ubica dentro de la barra', () => {
    const bar = getRangeBarData({ ...pool, priceAtOpen: 2668.73 });
    expect(bar.openPct).toBeGreaterThan(bar.rangeLowPct);
    expect(bar.openPct).toBeLessThan(bar.currentPct);
  });

  it('sin precio actual no pinta el marcador actual', () => {
    expect(getRangeBarData({ ...pool, priceCurrent: null, priceAtOpen: 2668.73 }).currentPct).toBeNull();
  });
});
