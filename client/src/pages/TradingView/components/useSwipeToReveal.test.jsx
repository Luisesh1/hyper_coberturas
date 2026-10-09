import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwipeToReveal } from './useSwipeToReveal';

const REVEAL = 96;

function setup({ enabled = true } = {}) {
  const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
  const hook = renderHook(({ on }) => useSwipeToReveal({ revealWidth: REVEAL, enabled: on }), {
    initialProps: { on: enabled },
  });
  const ev = (x, y = 0) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', currentTarget: target });
  // Gesto completo: down en x0, move(s), up en el último punto.
  const swipe = (id, ...xs) => {
    const h = () => hook.result.current.bind(id);
    act(() => h().onPointerDown(ev(xs[0])));
    for (const x of xs.slice(1)) act(() => h().onPointerMove(ev(x)));
    act(() => h().onPointerUp(ev(xs[xs.length - 1])));
  };
  return { ...hook, target, ev, swipe };
}

describe('useSwipeToReveal', () => {
  it('sigue al dedo hacia la izquierda, limitado al ancho revelable', () => {
    const { result, ev, target } = setup();
    act(() => result.current.bind('a').onPointerDown(ev(200)));
    act(() => result.current.bind('a').onPointerMove(ev(170)));
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
    expect(result.current.offsetFor('a')).toBe(-30);
    expect(result.current.isDragging('a')).toBe(true);
    act(() => result.current.bind('a').onPointerMove(ev(0)));
    expect(result.current.offsetFor('a')).toBe(-REVEAL);
    act(() => result.current.bind('a').onPointerMove(ev(260)));
    expect(result.current.offsetFor('a')).toBe(0);
  });

  it('pasado el umbral (mitad del ancho) queda abierta al soltar', () => {
    const { result, swipe } = setup();
    swipe('a', 200, 180, 140);
    expect(result.current.openId).toBe('a');
    expect(result.current.offsetFor('a')).toBe(-REVEAL);
    expect(result.current.isDragging('a')).toBe(false);
  });

  it('por debajo del umbral vuelve a cerrarse', () => {
    const { result, swipe } = setup();
    swipe('a', 200, 180, 170);
    expect(result.current.openId).toBe(null);
    expect(result.current.offsetFor('a')).toBe(0);
  });

  it('deslizar a la derecha cierra una fila abierta', () => {
    const { result, swipe } = setup();
    swipe('a', 200, 180, 100);
    expect(result.current.openId).toBe('a');
    swipe('a', 100, 120, 170);
    expect(result.current.openId).toBe(null);
  });

  it('abrir una fila cierra la que estuviera abierta', () => {
    const { result, swipe } = setup();
    swipe('a', 200, 180, 100);
    swipe('b', 200, 180, 100);
    expect(result.current.openId).toBe('b');
    expect(result.current.offsetFor('a')).toBe(0);
  });

  it('un gesto vertical no arrastra la fila (deja hacer scroll)', () => {
    const { result, ev, target } = setup();
    act(() => result.current.bind('a').onPointerDown(ev(200, 100)));
    act(() => result.current.bind('a').onPointerMove(ev(195, 140)));
    act(() => result.current.bind('a').onPointerMove(ev(150, 160)));
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    expect(result.current.offsetFor('a')).toBe(0);
    act(() => result.current.bind('a').onPointerUp(ev(150, 160)));
    expect(result.current.openId).toBe(null);
  });

  it('pointercancel devuelve la fila a su estado previo', () => {
    const { result, ev } = setup();
    act(() => result.current.bind('a').onPointerDown(ev(200)));
    act(() => result.current.bind('a').onPointerMove(ev(100)));
    act(() => result.current.bind('a').onPointerCancel(ev(100)));
    expect(result.current.openId).toBe(null);
    expect(result.current.offsetFor('a')).toBe(0);
  });

  describe('shouldSuppressClick', () => {
    it('se traga el click que sigue a un arrastre', () => {
      const { result, swipe } = setup();
      swipe('a', 200, 180, 170);
      let suppressed;
      act(() => { suppressed = result.current.shouldSuppressClick(); });
      expect(suppressed).toBe(true);
      act(() => { suppressed = result.current.shouldSuppressClick(); });
      expect(suppressed).toBe(false);
    });

    it('un toque con una fila abierta la cierra en vez de seleccionar', () => {
      const { result, swipe, ev } = setup();
      swipe('a', 200, 180, 100);
      // Toque limpio posterior: down + up sin movimiento.
      act(() => result.current.bind('a').onPointerDown(ev(50)));
      act(() => result.current.bind('a').onPointerUp(ev(50)));
      let suppressed;
      act(() => { suppressed = result.current.shouldSuppressClick(); });
      expect(suppressed).toBe(true);
      expect(result.current.openId).toBe(null);
    });

    it('un toque normal sin filas abiertas deja pasar el click', () => {
      const { result, ev } = setup();
      act(() => result.current.bind('a').onPointerDown(ev(50)));
      act(() => result.current.bind('a').onPointerUp(ev(50)));
      let suppressed;
      act(() => { suppressed = result.current.shouldSuppressClick(); });
      expect(suppressed).toBe(false);
    });
  });

  it('desactivado (escritorio) ignora los gestos y no desplaza nada', () => {
    const { result, swipe, target } = setup({ enabled: false });
    swipe('a', 200, 180, 100);
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    expect(result.current.openId).toBe(null);
    expect(result.current.offsetFor('a')).toBe(0);
  });

  it('al desactivarse con una fila abierta, la cierra', () => {
    const { result, swipe, rerender } = setup();
    swipe('a', 200, 180, 100);
    expect(result.current.openId).toBe('a');
    rerender({ on: false });
    expect(result.current.openId).toBe(null);
    expect(result.current.offsetFor('a')).toBe(0);
  });

  it('close() cierra la fila abierta', () => {
    const { result, swipe } = setup();
    swipe('a', 200, 180, 100);
    act(() => result.current.close());
    expect(result.current.openId).toBe(null);
  });
});
