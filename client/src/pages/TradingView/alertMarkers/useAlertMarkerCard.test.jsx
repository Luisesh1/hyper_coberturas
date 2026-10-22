import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { useAlertMarkerCard } from './useAlertMarkerCard';

function fakeChart() {
  const h = { move: null, click: null };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ts = { getVisibleRange: vi.fn(() => ({ from: 0, to: 1000 })), setVisibleRange: vi.fn() };
  const chart = {
    subscribeCrosshairMove: (fn) => { h.move = fn; },
    unsubscribeCrosshairMove: () => { h.move = null; },
    subscribeClick: (fn) => { h.click = fn; },
    unsubscribeClick: () => { h.click = null; },
    chartElement: () => el,
    timeScale: () => ts,
  };
  return { chart, h, el, ts };
}

const e = (evalTime) => ({ evalTime, suppressed: false });
const A1 = { alertId: 'a', event: e(100_000), sec: 100 };
const B1 = { alertId: 'b', event: e(100_500), sec: 100 };
const A2 = { alertId: 'a', event: e(5_000_000), sec: 5000 };
const TIMELINE = [A1, B1, A2];
const P = { x: 10, y: 20 };

function setup(props = {}) {
  const f = fakeChart();
  const chartRef = { current: f.chart };
  const hook = renderHook((p) => useAlertMarkerCard(p), {
    initialProps: { chartRef, mobile: false, timeline: TIMELINE, disabled: false, ...props },
  });
  return { ...f, hook, chartRef };
}

describe('useAlertMarkerCard (escritorio)', () => {
  it('pasar por una vela con disparos muestra todos los de la vela; fuera la oculta', () => {
    const { h, hook } = setup();
    expect(hook.result.current.card).toBeNull();
    act(() => h.move({ time: 100, point: P }));
    expect(hook.result.current.card.entries).toEqual([A1, B1]);
    expect(hook.result.current.card.index).toBeUndefined();
    expect(hook.result.current.card.anchor).toEqual(P);
    act(() => h.move({ time: 300, point: P }));
    expect(hook.result.current.card).toBeNull();
  });

  it('el clic la fija (el hover ya no la cambia); clic fuera o Esc la cierran', () => {
    const { h, hook } = setup();
    act(() => h.move({ time: 100, point: P }));
    expect(hook.result.current.pinned).toBe(false);
    act(() => h.click({ time: 100, point: P }));
    expect(hook.result.current.pinned).toBe(true);
    act(() => h.move({ time: 300, point: P }));
    expect(hook.result.current.card.entries).toHaveLength(2);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(hook.result.current.card).toBeNull();

    act(() => h.click({ time: 100, point: P }));
    act(() => { fireEvent.pointerDown(document.body); });
    expect(hook.result.current.card).toBeNull();

    act(() => h.click({ time: 100, point: P }));
    act(() => h.click({ time: 300, point: P }));
    expect(hook.result.current.card).toBeNull();
  });

  it('un clic dentro de la tarjeta no la cierra', () => {
    const { h, hook } = setup();
    const inside = document.createElement('div');
    document.body.appendChild(inside);
    hook.result.current.cardRef.current = inside;
    act(() => h.click({ time: 100, point: P }));
    act(() => { fireEvent.pointerDown(inside); });
    expect(hook.result.current.card).not.toBeNull();
  });

  it('deshabilitado (herramienta de dibujo) no reacciona', () => {
    const { h, hook, chartRef } = setup();
    hook.rerender({ chartRef, mobile: false, timeline: TIMELINE, disabled: true });
    expect(h.move).toBeNull();
    expect(h.click).toBeNull();
    expect(hook.result.current.card).toBeNull();
  });

  it('ignoreSynthetic: un movimiento sin sourceEvent (puntero sincronizado) no la abre', () => {
    const { h, hook } = setup({ ignoreSynthetic: true });
    act(() => h.move({ time: 100, point: P }));
    expect(hook.result.current.card).toBeNull();
    act(() => h.move({ time: 100, point: P, sourceEvent: {} }));
    expect(hook.result.current.card.entries).toEqual([A1, B1]);
  });
});

describe('useAlertMarkerCard (móvil)', () => {
  it('tocar una vela abre su primer disparo y ‹ › recorren solo los de esa alerta, en orden temporal', () => {
    const { h, hook, ts } = setup({ mobile: true });
    act(() => h.move({ time: 100, point: P }));
    expect(hook.result.current.card).toBeNull();
    act(() => h.click({ time: 100, point: P }));
    let card = hook.result.current.card;
    // B1 comparte vela con A1 pero es de otra alerta: no entra en la navegación.
    expect(card.entries).toEqual([A1, A2]);
    expect(card.index).toBe(0);
    act(() => card.onNext());
    card = hook.result.current.card;
    expect(card.index).toBe(1);
    expect(card.entries[card.index]).toBe(A2);
    // El siguiente disparo cae fuera de la vista: el gráfico se desplaza hasta él.
    expect(ts.setVisibleRange).toHaveBeenCalledWith({ from: 4500, to: 5500 });
    act(() => card.onPrev());
    expect(hook.result.current.card.index).toBe(0);
    expect(hook.result.current.card.entries[0]).toBe(A1);
    act(() => hook.result.current.card.onClose());
    expect(hook.result.current.card).toBeNull();
  });

  it('si el disparo elegido desaparece (p. ej. se oculta la alerta), se cierra', () => {
    const { h, hook, chartRef } = setup({ mobile: true });
    act(() => h.click({ time: 100, point: P }));
    hook.rerender({ chartRef, mobile: true, timeline: [A2], disabled: false });
    expect(hook.result.current.card).toBeNull();
  });
});
