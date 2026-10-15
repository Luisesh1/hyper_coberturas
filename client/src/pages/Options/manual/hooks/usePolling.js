import { useCallback, useEffect, useRef, useState } from 'react';

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Llama a `fetcher` al montar y cada `intervalMs`. Se pausa con la pestaña
 * oculta y refresca al volver. `key` reinicia el sondeo (y limpia los datos)
 * cuando cambian los parámetros; `enabled: false` lo detiene.
 */
export function usePolling(fetcher, { intervalMs, enabled = true, key = '' } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled, key });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  // Al cambiar la clave, los datos anteriores ya no valen.
  if (state.key !== key) {
    setState({ data: null, error: null, loading: enabled, key });
  }

  const run = useCallback(async () => {
    const id = ++seq.current;
    try {
      const data = await fetcherRef.current();
      if (id !== seq.current) return;
      setState((s) => ({ ...s, data, error: null, loading: false }));
    } catch (error) {
      if (id !== seq.current) return;
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => {
      stop();
      if (isHidden()) return;
      run();
      timer = setInterval(() => { if (!isHidden()) run(); }, intervalMs);
    };
    const onVisibility = () => { if (isHidden()) stop(); else start(); };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      seq.current += 1; // descarta respuestas en vuelo
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, key, run]);

  return { data: state.data, error: state.error, loading: enabled && state.loading, refresh: run };
}
