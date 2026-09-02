import { describe, expect, it } from 'vitest';
import { computeNoOpBand } from './OrchestratorRangeBar';

const centro = (pct) => ({ kind: 'center', pct });

// Rango real del orquestador 45 (ETH/USDC), tal como llega en el snapshot.
const RANGO = {
  lowerPrice: 2387.53,
  upperPrice: 2519.99,
  // El track reserva un padding a cada lado para el precio fuera de rango,
  // así que el rango NO ocupa de 0 a 100.
  rangeLowPct: 13,
  rangeHighPct: 87,
};

describe('computeNoOpBand', () => {
  it('centra la banda en el medio geométrico, que es donde la mide el motor', () => {
    const band = computeNoOpBand({ ...RANGO, zone: centro(40) });
    const geometricMid = Math.sqrt(RANGO.lowerPrice * RANGO.upperPrice);
    // El centro de la banda en precio es la media geométrica, no la aritmética:
    // el motor ubica el precio dentro del rango en escala logarítmica.
    expect(Math.sqrt(band.lowerPrice * band.upperPrice)).toBeCloseTo(geometricMid, 6);
    expect((band.lowerPrice + band.upperPrice) / 2).not.toBeCloseTo(geometricMid, 6);
  });

  it('la banda ocupa el % pedido del rango, medido como el motor lo mide', () => {
    const band = computeNoOpBand({ ...RANGO, zone: centro(40) });
    const span = Math.log(RANGO.upperPrice / RANGO.lowerPrice);
    const fraccion = Math.log(band.upperPrice / band.lowerPrice) / span;
    expect(fraccion * 100).toBeCloseTo(40, 6);
  });

  it('se dibuja dentro del rango del track, nunca sobre el padding', () => {
    const band = computeNoOpBand({ ...RANGO, zone: centro(90) });
    expect(band.leftPct).toBeGreaterThanOrEqual(RANGO.rangeLowPct);
    expect(band.leftPct + band.widthPct).toBeLessThanOrEqual(RANGO.rangeHighPct);
  });

  it('recorta al máximo que el servidor acepta', () => {
    const band = computeNoOpBand({ ...RANGO, zone: centro(500) });
    expect(band.pct).toBe(90);
  });

  it('sin zona muerta no hay banda que dibujar', () => {
    expect(computeNoOpBand({ ...RANGO, zone: { kind: 'none', pct: 0 } })).toBeNull();
    expect(computeNoOpBand({ ...RANGO, zone: centro(0) })).toBeNull();
    expect(computeNoOpBand({ ...RANGO, zone: null })).toBeNull();
    expect(computeNoOpBand({ ...RANGO, zone: centro(null) })).toBeNull();
  });

  it('borde de rango congela el rango ENTERO, no una banda central', () => {
    // No es un caso decorativo: esa politica no toca el hedge mientras el
    // precio siga dentro del rango, asi que la zona sin operacion es todo el
    // rango. Dibujarle una banda central seria pintar una restriccion que no
    // tiene y esconder la que si tiene.
    const band = computeNoOpBand({ ...RANGO, zone: { kind: 'full_range', pct: 100 } });
    expect(band.kind).toBe('full_range');
    expect(band.leftPct).toBe(RANGO.rangeLowPct);
    expect(band.leftPct + band.widthPct).toBe(RANGO.rangeHighPct);
    expect(band.lowerPrice).toBe(RANGO.lowerPrice);
    expect(band.upperPrice).toBe(RANGO.upperPrice);
  });

  it('un rango inválido no dibuja nada en vez de dibujar cualquier cosa', () => {
    expect(computeNoOpBand({ ...RANGO, zone: centro(40), lowerPrice: 0 })).toBeNull();
    expect(computeNoOpBand({ ...RANGO, zone: centro(40), upperPrice: RANGO.lowerPrice })).toBeNull();
  });
});
