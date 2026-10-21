import { describe, expect, it } from 'vitest';
import { aggregateChange, walletChange } from './walletSeries';

const H = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % H);
const p = (h, total) => ({ t: T0 + h * H, total });

describe('walletChange', () => {
  it('compara el primer y el ultimo punto del rango', () => {
    expect(walletChange([p(0, 100), p(1, 90), p(2, 120)])).toEqual({
      firstUsd: 100, lastUsd: 120, changeUsd: 20, changePct: 20,
    });
  });

  it('sin puntos no hay cambio', () => {
    expect(walletChange([])).toBeNull();
  });

  it('con base cero no inventa un porcentaje', () => {
    expect(walletChange([p(0, 0), p(1, 50)]).changePct).toBeNull();
  });
});

describe('aggregateChange', () => {
  it('suma los cambios por wallet: una wallet que entra a mitad no cuenta como ganancia', () => {
    const series = {
      1: [p(0, 100), p(1, 110), p(2, 120)],
      2: [p(1, 1000), p(2, 990)], // entra en la hora 1 con $1000
    };
    const agg = aggregateChange(series);
    expect(agg.changeUsd).toBe(10); // +20 de la 1, -10 de la 2
    expect(agg.basisUsd).toBe(1100);
    expect(agg.changePct).toBeCloseTo((10 / 1100) * 100);
    expect(agg.curve).toEqual([
      { t: T0, value: 0 },
      { t: T0 + H, value: 10 },
      { t: T0 + 2 * H, value: 10 },
    ]);
  });

  it('una wallet archivada conserva su cambio hasta su ultimo punto', () => {
    const series = {
      1: [p(0, 100), p(1, 80)], // archivada tras la hora 1
      2: [p(0, 50), p(1, 50), p(2, 60)],
    };
    const agg = aggregateChange(series);
    expect(agg.changeUsd).toBe(-10);
    expect(agg.curve.at(-1)).toEqual({ t: T0 + 2 * H, value: -10 });
  });

  it('alinea capturas de la misma hora con segundos de diferencia', () => {
    const series = {
      1: [{ t: T0 + 12_000, total: 10 }, { t: T0 + H + 9_000, total: 15 }],
      2: [{ t: T0 + 40_000, total: 5 }, { t: T0 + H + 30_000, total: 4 }],
    };
    const agg = aggregateChange(series);
    expect(agg.curve).toHaveLength(2);
    expect(agg.curve[1].value).toBe(4);
  });

  it('sin datos devuelve nulos', () => {
    expect(aggregateChange({ 1: [] })).toEqual({ changeUsd: null, basisUsd: null, changePct: null, curve: [] });
  });
});
