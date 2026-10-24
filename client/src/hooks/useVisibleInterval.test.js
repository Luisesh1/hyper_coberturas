import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisibleInterval } from './useVisibleInterval';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

describe('useVisibleInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
  afterEach(() => { vi.useRealTimers(); setVisibility('visible'); });

  it('no llama mientras la pestaña está oculta', () => {
    setVisibility('hidden');
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 1000));
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(0);
  });

  it('al volver a ser visible llama enseguida', () => {
    setVisibility('hidden');
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 1000));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('visible llama cada ms', () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 1000));
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('enabled=false no programa', () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 1000, false));
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(0);
  });
});
