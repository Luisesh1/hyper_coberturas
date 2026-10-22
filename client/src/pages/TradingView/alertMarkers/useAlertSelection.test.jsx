import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  alertsApi: { list: vi.fn(), backtest: vi.fn() },
  settingsApi: { getChartAlertMarkers: vi.fn(), saveChartAlertMarkers: vi.fn() },
}));

import { alertsApi, settingsApi } from '../../../services/api';
import { useAlertSelection } from './useAlertSelection';

beforeEach(() => {
  vi.clearAllMocks();
  alertsApi.list.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
  settingsApi.getChartAlertMarkers.mockResolvedValue({ items: [{ alertId: 'a1', color: '#facc15', hidden: false }] });
  settingsApi.saveChartAlertMarkers.mockResolvedValue({});
});

describe('useAlertSelection', () => {
  it('carga alertas y selección', async () => {
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.alertsById.a2).toEqual({ id: 'a2' });
    expect(result.current.items).toHaveLength(1);
  });

  it('enabled = false no carga nada; al activarse carga una vez', async () => {
    const { result, rerender } = renderHook((p) => useAlertSelection(p), { initialProps: { enabled: false } });
    await act(async () => { await Promise.resolve(); });
    expect(alertsApi.list).not.toHaveBeenCalled();
    expect(settingsApi.getChartAlertMarkers).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => { await Promise.resolve(); });
    expect(alertsApi.list).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);
  });

  it('aplica al momento y guarda', async () => {
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.add('a2'); });
    expect(result.current.items.map((i) => i.alertId)).toEqual(['a1', 'a2']);
    await waitFor(() => expect(settingsApi.saveChartAlertMarkers).toHaveBeenCalledTimes(1));
  });

  it('revierte si el guardado falla', async () => {
    settingsApi.saveChartAlertMarkers.mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.toggleHidden('a1'); });
    expect(result.current.items[0].hidden).toBe(true);
    await waitFor(() => expect(result.current.items[0].hidden).toBe(false));
  });

  it('guardados en serie: dos cambios rápidos que fallan acaban en el estado confirmado', async () => {
    settingsApi.saveChartAlertMarkers.mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.toggleHidden('a1'); });
    act(() => { result.current.add('a2'); });
    await waitFor(() => expect(result.current.saveError).toBe('x'));
    expect(result.current.items).toEqual([{ alertId: 'a1', color: '#facc15', hidden: false }]);
    expect(settingsApi.saveChartAlertMarkers).toHaveBeenCalledTimes(1);
  });

  it('guarda el último estado cuando el guardado anterior termina', async () => {
    let first;
    settingsApi.saveChartAlertMarkers.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.toggleHidden('a1'); });
    act(() => { result.current.add('a2'); });
    expect(settingsApi.saveChartAlertMarkers).toHaveBeenCalledTimes(1);
    await act(async () => { first({}); });
    await waitFor(() => expect(settingsApi.saveChartAlertMarkers).toHaveBeenCalledTimes(2));
    expect(settingsApi.saveChartAlertMarkers.mock.calls[1][0].items.map((i) => i.alertId)).toEqual(['a1', 'a2']);
  });

  it('si la selección guardada no carga, los cambios son no-ops', async () => {
    settingsApi.getChartAlertMarkers.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe('down');
    act(() => { result.current.add('a2'); });
    expect(result.current.items).toEqual([]);
    expect(settingsApi.saveChartAlertMarkers).not.toHaveBeenCalled();
  });

  it('si falla la lista de alertas lo expone', async () => {
    alertsApi.list.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useAlertSelection());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.alertsStatus).toBe('error');
    expect(result.current.items).toHaveLength(1);
  });
});
