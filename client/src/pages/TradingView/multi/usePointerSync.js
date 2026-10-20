import { useCallback, useEffect, useRef, useState } from 'react';

// Puntero compartido entre los gráficos de la pantalla multi. Se agrupa por
// fotograma para no re-renderizar por cada píxel; con la sincronización
// apagada nadie lee `sync`, así que onPointer no programa nada.
export default function usePointerSync(syncEnabled) {
  const [sync, setSync] = useState(null);
  const syncEnabledRef = useRef(syncEnabled);
  syncEnabledRef.current = syncEnabled;

  const pendingRef = useRef(null);
  const rafRef = useRef(0);
  const scheduledRef = useRef(false);
  const onPointer = useCallback((index, p) => {
    if (!syncEnabledRef.current) return;
    pendingRef.current = { value: p ? { sourceIndex: index, ...p } : null };
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    rafRef.current = requestAnimationFrame(() => {
      scheduledRef.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) setSync(pending.value);
    });
  }, []);
  useEffect(() => () => {
    if (scheduledRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  return { sync, setSync, onPointer };
}
