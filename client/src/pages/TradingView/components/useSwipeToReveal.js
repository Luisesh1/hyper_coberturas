import { useCallback, useRef, useState } from 'react';

// Distancia mínima antes de decidir si el gesto es horizontal (arrastre de
// la fila) o vertical (scroll de la lista). Por debajo es un toque.
const SLOP = 8;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Máquina de estados de «deslizar para revelar» para una lista de filas.
 * Vive a nivel de lista para que abrir una fila cierre la anterior.
 *
 * - `bind(id)` devuelve los handlers de pointer events para la fila.
 * - `offsetFor(id)` es el desplazamiento X (≤ 0) a aplicar al contenido.
 * - `isDragging(id)` permite quitar la transición mientras sigue al dedo.
 * - `shouldSuppressClick()` se llama en el click de la fila: devuelve true
 *   (y cierra la fila abierta) si ese click no debe seleccionar.
 */
export function useSwipeToReveal({ revealWidth = 96, enabled = true } = {}) {
  const [openId, setOpenId] = useState(null);
  const [drag, setDrag] = useState(null); // { id, offset } mientras se arrastra
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  // Ajuste durante el render (no en un efecto): al pasar a escritorio no
  // debe quedar ninguna fila desplazada.
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (!enabled) { setOpenId(null); setDrag(null); }
  }

  const gesture = useRef(null); // { id, pointerId, x0, y0, base, phase }
  const openRef = useRef(openId);
  openRef.current = openId;
  const suppressNextClick = useRef(false);

  const finish = useCallback((e, commit) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.phase !== 'dragging') return;
    try { e.currentTarget?.releasePointerCapture?.(g.pointerId); } catch { /* ya liberado */ }
    // El navegador lanza un click tras el pointerup: no debe seleccionar.
    suppressNextClick.current = true;
    if (commit) {
      const offset = clamp(g.base + (e.clientX - g.x0), -revealWidth, 0);
      setOpenId(offset <= -revealWidth / 2 ? g.id : null);
    }
    setDrag(null);
  }, [revealWidth]);

  const bind = useCallback((id) => ({
    onPointerDown: (e) => {
      if (!enabled) return;
      suppressNextClick.current = false;
      gesture.current = {
        id,
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        base: openRef.current === id ? -revealWidth : 0,
        phase: 'pending',
      };
    },
    onPointerMove: (e) => {
      const g = gesture.current;
      if (!g || g.id !== id) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (g.phase === 'pending') {
        if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
          // Es scroll vertical: soltamos el gesto y dejamos hacer al navegador.
          g.phase = 'ignored';
          return;
        }
        if (Math.abs(dx) <= SLOP) return;
        g.phase = 'dragging';
        try { e.currentTarget?.setPointerCapture?.(g.pointerId); } catch { /* sin captura */ }
        if (openRef.current !== null && openRef.current !== id) setOpenId(null);
      }
      if (g.phase !== 'dragging') return;
      setDrag({ id, offset: clamp(g.base + dx, -revealWidth, 0) });
    },
    onPointerUp: (e) => finish(e, true),
    onPointerCancel: (e) => finish(e, false),
  }), [enabled, revealWidth, finish]);

  const shouldSuppressClick = useCallback(() => {
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return true;
    }
    if (openRef.current !== null) {
      setOpenId(null);
      return true;
    }
    return false;
  }, []);

  const close = useCallback(() => setOpenId(null), []);

  const offsetFor = (id) => {
    if (!enabled) return 0;
    if (drag?.id === id) return drag.offset;
    return openId === id ? -revealWidth : 0;
  };
  const isDragging = (id) => enabled && drag?.id === id;

  return { openId: enabled ? openId : null, bind, offsetFor, isDragging, shouldSuppressClick, close };
}
