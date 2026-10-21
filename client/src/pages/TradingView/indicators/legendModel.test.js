import { describe, it, expect } from 'vitest';
import { buildIndicatorLegend, toggleIndicatorVisible } from './legendModel';

const ema10 = { uid: 'e10', type: 'ema', visible: true, params: { length: 10 }, style: {} };
const ema55 = { uid: 'e55', type: 'ema', visible: false, params: { length: 55 }, style: {} };
const sqz = { uid: 'sqz', type: 'sqzmom', visible: true, params: {}, style: {} };

describe('buildIndicatorLegend', () => {
  it('sigue el orden de la configuración e incluye los ocultos sin valores', () => {
    const rows = [
      { uid: 'sqz', type: 'sqzmom', label: 'Squeeze Momentum', params: {}, values: [{ role: 'histogram', value: 1, color: '#0f0' }] },
      { uid: 'e10', type: 'ema', label: 'EMA', params: { length: 10 }, values: [{ role: 'line', value: 2419.85, color: '#f00' }] },
    ];
    const legend = buildIndicatorLegend([ema10, ema55, sqz], rows);
    expect(legend.map((r) => r.uid)).toEqual(['e10', 'e55', 'sqz']);
    expect(legend[0]).toMatchObject({ hidden: false, values: rows[1].values });
    expect(legend[1]).toMatchObject({ uid: 'e55', type: 'ema', label: 'EMA', params: { length: 55 }, hidden: true, values: [] });
    expect(legend[2].hidden).toBe(false);
  });

  it('un visible que el controlador aún no montó sale sin valores, no oculto', () => {
    const legend = buildIndicatorLegend([ema10], []);
    expect(legend).toEqual([
      expect.objectContaining({ uid: 'e10', hidden: false, values: [] }),
    ]);
  });

  it('descarta tipos desconocidos y entradas inválidas', () => {
    const legend = buildIndicatorLegend([null, { uid: 'x', type: 'nope', visible: true }, ema10], []);
    expect(legend.map((r) => r.uid)).toEqual(['e10']);
  });

  it('sin indicadores devuelve una lista vacía', () => {
    expect(buildIndicatorLegend(undefined, undefined)).toEqual([]);
  });
});

describe('toggleIndicatorVisible', () => {
  it('invierte solo el indicador indicado y no muta la entrada', () => {
    const list = [ema10, ema55];
    const next = toggleIndicatorVisible(list, 'e10');
    expect(next[0].visible).toBe(false);
    expect(next[1]).toBe(ema55);
    expect(list[0].visible).toBe(true);
  });

  it('un indicador sin `visible` cuenta como visible y pasa a oculto', () => {
    const next = toggleIndicatorVisible([{ uid: 'a', type: 'ema' }], 'a');
    expect(next[0].visible).toBe(false);
  });

  it('un uid desconocido devuelve la misma lista', () => {
    const list = [ema10];
    expect(toggleIndicatorVisible(list, 'zz')).toBe(list);
  });
});
