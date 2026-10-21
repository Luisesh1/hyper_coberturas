import { describe, expect, it, vi } from 'vitest';
import { createIndicatorsController } from './renderAdapter';

function fakeChart() {
  const series = [];
  const panes = [];
  return {
    series,
    panes: () => panes,
    addSeries: vi.fn((_type, opts, paneIndex = 0) => {
      const s = {
        opts: { ...opts },
        paneIndex,
        setData: vi.fn(),
        applyOptions: vi.fn((o) => Object.assign(s.opts, o)),
        options: () => s.opts,
        priceScale: () => ({ applyOptions: vi.fn() }),
      };
      series.push(s);
      while (panes.length <= paneIndex) panes.push({ setStretchFactor: vi.fn() });
      return s;
    }),
    removeSeries: vi.fn(),
    removePane: vi.fn(),
  };
}

const candles = Array.from({ length: 80 }, (_, i) => {
  const open = 2500 + Math.sin(i / 4) * 20;
  const close = open + (i % 3 === 0 ? -4 : 5);
  return {
    time: Date.UTC(2026, 9, 19) + i * 3_600_000,
    open, high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close, volume: 100,
  };
});

const sqzmom = {
  uid: 'sqz', type: 'sqzmom', visible: true, style: {},
  params: { length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true },
};

describe('createIndicatorsController — modo compacto (paneles chicos en móvil)', () => {
  it('por defecto conserva títulos y etiquetas de los indicadores', () => {
    const chart = fakeChart();
    createIndicatorsController(chart).render([sqzmom], candles);
    const titled = chart.series.filter((s) => s.opts.title);
    expect(titled.length).toBeGreaterThan(0);
    expect(chart.series.some((s) => s.opts.lastValueVisible === true)).toBe(true);
    expect(chart.panes()[0].setStretchFactor).toHaveBeenLastCalledWith(0.65);
  });

  it('compacto: sin títulos ni etiqueta de último valor y más alto el panel de precio', () => {
    const chart = fakeChart();
    createIndicatorsController(chart, { compact: true }).render([sqzmom], candles);
    expect(chart.series.length).toBeGreaterThan(0);
    for (const s of chart.series) {
      expect(s.opts.title || '').toBe('');
      expect(s.opts.lastValueVisible).toBe(false);
    }
    expect(chart.panes()[0].setStretchFactor).toHaveBeenLastCalledWith(0.78);
    expect(chart.panes()[1].setStretchFactor).toHaveBeenLastCalledWith(0.22);
  });
});

describe('createIndicatorsController — ATR Bands', () => {
  it('pinta dos líneas sobre el precio (panel 0), superior e inferior', () => {
    const chart = fakeChart();
    createIndicatorsController(chart).render([
      { uid: 'ab', type: 'atrbands', visible: true, style: {}, params: { length: 14, multiplier: 2 } },
    ], candles);
    expect(chart.series).toHaveLength(2);
    expect(chart.series.every((s) => s.paneIndex === 0)).toBe(true);
    expect(chart.series.map((s) => s.opts.title)).toEqual(['ATR Bands Up', 'ATR Bands Lo']);
    for (const s of chart.series) {
      const data = s.setData.mock.calls.at(-1)[0];
      expect(data.length).toBeGreaterThan(0);
    }
  });

  it('cambiar el color recolorea las dos bandas', () => {
    const chart = fakeChart();
    const ctrl = createIndicatorsController(chart);
    const entry = { uid: 'ab', type: 'atrbands', visible: true, style: {}, params: { length: 14, multiplier: 2 } };
    ctrl.render([entry], candles);
    ctrl.render([{ ...entry, style: { color: '#123456' } }], candles);
    expect(chart.series.map((s) => s.opts.color)).toEqual(['#123456', '#123456']);
  });
});
