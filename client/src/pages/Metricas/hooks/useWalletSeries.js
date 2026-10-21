import { useEffect, useState } from 'react';
import { walletMetricsApi } from '../../../services/api';

const POLL_MS = 5 * 60_000;

/**
 * Series de las wallets visibles en una sola llamada. `reloadKey` fuerza la
 * recarga cuando la lista trae una captura nueva.
 */
export default function useWalletSeries(ids, range, reloadKey) {
  const [state, setState] = useState({ byId: {}, loading: false, error: null });
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!idsKey) {
      setState({ byId: {}, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const startAt = range?.ms ? Date.now() - range.ms : undefined;
        const byId = await walletMetricsApi.getSnapshots({ ids: idsKey.split(','), startAt });
        if (!cancelled) setState({ byId: byId || {}, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false, error: err?.message || 'Error cargando la serie' }));
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [idsKey, range?.ms, reloadKey]);

  return state;
}
