import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';

vi.mock('../../../services/api', () => ({
  settingsApi: {
    getChartDrawings: vi.fn().mockResolvedValue({ drawings: [] }),
    saveChartDrawings: vi.fn().mockResolvedValue({}),
  },
}));

import { useDrawings } from './use-drawings';

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  }
});

// Chart y serie identidad: x ↔ time, y ↔ price, suficiente para el hook.
function makeChart() {
  const timeScale = {
    coordinateToTime: (x) => x,
    timeToCoordinate: (t) => t,
    coordinateToLogical: (x) => x,
    logicalToCoordinate: (l) => l,
    subscribeVisibleLogicalRangeChange: () => {},
    unsubscribeVisibleLogicalRangeChange: () => {},
  };
  return { timeScale: () => timeScale };
}

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    // Contexto 2D falso: cualquier método es un no-op.
    getContext: () => new Proxy({}, { get: () => () => ({ width: 0 }) }),
    setPointerCapture: vi.fn(),
  };
}

function setup(activeTool) {
  const setActiveTool = vi.fn();
  const canvas = makeCanvas();
  const hook = renderHook(() => {
    const chartRef = useRef(makeChart());
    const seriesRef = useRef({ priceToCoordinate: (p) => p, coordinateToPrice: (y) => y });
    const candlesRef = useRef([{ time: 1_000_000 }]);
    const containerRef = useRef(canvas);
    const canvasRef = useRef(canvas);
    return useDrawings({
      chartRef, seriesRef, candlesRef, containerRef, canvasRef,
      symbol: 'ETH', timeframe: '1m', activeTool, setActiveTool,
    });
  });
  return { ...hook, canvas, setActiveTool };
}

const pointer = (canvas, x, y) => ({ clientX: x, clientY: y, pointerId: 1, currentTarget: canvas });

describe('useDrawings con pointer events', () => {
  it('traza una línea de tendencia arrastrando con el dedo (pointer down → up)', async () => {
    const { result, canvas } = setup('trendline');
    await waitFor(() => expect(result.current.drawings).toEqual([]));

    act(() => result.current.onPointerDown(pointer(canvas, 10, 20)));
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    act(() => result.current.onPointerMove(pointer(canvas, 60, 50)));
    act(() => result.current.onPointerUp(pointer(canvas, 120, 80)));

    expect(result.current.drawings).toHaveLength(1);
    expect(result.current.drawings[0].anchors).toEqual([
      { time: 10, price: 20 },
      { time: 120, price: 80 },
    ]);
  });

  it('deshace la última acción y deja de poder deshacer al vaciar el historial', async () => {
    const { result, canvas } = setup('trendline');
    await waitFor(() => expect(result.current.drawings).toEqual([]));
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.onPointerDown(pointer(canvas, 10, 20)));
    act(() => result.current.onPointerUp(pointer(canvas, 120, 80)));
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.clearAll());
    expect(result.current.drawings).toHaveLength(0);

    act(() => result.current.undo());
    expect(result.current.drawings).toHaveLength(1);

    act(() => result.current.undo());
    expect(result.current.drawings).toHaveLength(0);
    expect(result.current.canUndo).toBe(false);
  });
});
