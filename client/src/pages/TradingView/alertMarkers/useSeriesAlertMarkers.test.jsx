import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const lw = vi.hoisted(() => ({ plugins: [], create: vi.fn() }));
vi.mock('lightweight-charts', () => ({
  createSeriesMarkers: (...a) => lw.create(...a),
}));

import { useSeriesAlertMarkers } from './useSeriesAlertMarkers';

beforeEach(() => {
  lw.plugins.length = 0;
  lw.create.mockImplementation((series) => {
    const p = { series, setMarkers: vi.fn(), detach: vi.fn() };
    lw.plugins.push(p);
    return p;
  });
});

describe('useSeriesAlertMarkers', () => {
  it('crea el plugin, aplica marcas al cambiar y desengancha al desmontar', () => {
    const s1 = {};
    const ref = { current: s1 };
    const m1 = [{ time: 1 }];
    const hook = renderHook((p) => useSeriesAlertMarkers(p), { initialProps: { seriesRef: ref, markers: m1 } });
    expect(lw.create).toHaveBeenCalledTimes(1);
    expect(lw.plugins[0].setMarkers).toHaveBeenLastCalledWith(m1);
    hook.rerender({ seriesRef: ref, markers: m1 });
    expect(lw.plugins[0].setMarkers).toHaveBeenCalledTimes(1);
    const m2 = [{ time: 2 }];
    hook.rerender({ seriesRef: ref, markers: m2 });
    expect(lw.plugins[0].setMarkers).toHaveBeenLastCalledWith(m2);
    hook.unmount();
    expect(lw.plugins[0].detach).toHaveBeenCalled();
  });

  it('vuelve a enganchar si la serie se recrea', () => {
    const ref = { current: {} };
    const m = [{ time: 1 }];
    const hook = renderHook((p) => useSeriesAlertMarkers(p), { initialProps: { seriesRef: ref, markers: m } });
    ref.current = {};
    hook.rerender({ seriesRef: ref, markers: m });
    expect(lw.plugins[0].detach).toHaveBeenCalled();
    expect(lw.plugins).toHaveLength(2);
    expect(lw.plugins[1].setMarkers).toHaveBeenLastCalledWith(m);
  });
});
