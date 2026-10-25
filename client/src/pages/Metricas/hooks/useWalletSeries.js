import { useCallback, useEffect, useRef, useState } from 'react';
import { walletMetricsApi } from '../../../services/api';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';

const POLL_MS = 5 * 60_000;

/**
 * Series de las wallets visibles en una sola llamada. `reloadKey` fuerza la
 * recarga cuando la lista trae una captura nueva.
 */
export default function useWalletSeries(ids, range, reloadKey) {
  const [state, setState] = useState({ byId: {}, loading: false, error: null });
  const idsKey = ids.join(',');
  const rangeMs = range?.ms;
  // Descarta respuestas de cargas anteriores (cambio de ids/rango o desmontaje).
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const startAt = rangeMs ? Date.now() - rangeMs : undefined;
      const byId = await walletMetricsApi.getSnapshots({ ids: idsKey.split(','), startAt });
      if (request === requestRef.current) setState({ byId: byId || {}, loading: false, error: null });
    } catch (err) {
      if (request === requestRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: err?.message || 'Error cargando la serie' }));
      }
    }
  }, [idsKey, rangeMs]);

  useEffect(() => {
    if (!idsKey) {
      requestRef.current += 1;
      setState({ byId: {}, loading: false, error: null });
      return undefined;
    }
    load();
    return () => { requestRef.current += 1; };
    // reloadKey fuerza la recarga cuando la lista trae una captura nueva.
  }, [idsKey, load, reloadKey]);

  useVisibleInterval(load, POLL_MS, Boolean(idsKey));

  return state;
}
