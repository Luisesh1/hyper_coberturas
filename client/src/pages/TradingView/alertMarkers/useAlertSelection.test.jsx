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
});
