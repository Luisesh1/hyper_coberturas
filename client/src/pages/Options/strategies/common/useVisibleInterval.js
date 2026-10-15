import { useEffect, useRef } from 'react';

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

// Llama a `callback` cada `ms` mientras `enabled` y la pestaña del navegador
// esté visible. Al volver a ser visible refresca enseguida.
export function useVisibleInterval(callback, ms, enabled = true) {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);

  useEffect(() => {
    if (!enabled || !ms) return undefined;
    const id = setInterval(() => {
      if (!isHidden()) saved.current?.();
    }, ms);
    const onVisibility = () => { if (!isHidden()) saved.current?.(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, enabled]);
}
