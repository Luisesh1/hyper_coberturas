import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useReplayController } from './useReplayController';

describe('useReplayController stop', () => {
  it('notifica al padre para que recargue los datos vivos', () => {
    const onStopped = vi.fn();
    const { result } = renderHook(() => {
      const candleSeriesRef = useRef({ setData: vi.fn() });
      const candlesRef = useRef([]);
      const indicatorsControllerRef = useRef({ render: vi.fn() });
      const indicatorsRef = useRef([]);
      const chartRef = useRef(null);
      return useReplayController({
        asset: { symbol: 'BTC', datasource: 'binance' },
        timeframe: '1m',
        candleSeriesRef,
        candlesRef,
        indicatorsControllerRef,
        indicatorsRef,
        chartRef,
        onStopped,
      });
    });

    act(() => result.current.stop());
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});
