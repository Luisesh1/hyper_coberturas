import { useEffect, useMemo, useState } from 'react';
import { metricsApi } from '../../../services/api';

/**
 * Trae la serie de snapshots de todos los orquestadores una sola vez por
 * rango, en vez de que cada tarjeta pida la suya al montarse.
 *
 * Dos consecuencias que importan: la fila colapsada puede mostrar sparkline y
 * PnL sin abrir la grafica, y el poll de 60s de la pagina —que solo refresca
 * la lista de orquestadores— deja de re-pedir snapshots horarios, porque la
 * dependencia es la lista de ids, no la identidad del array.
 */
export default function useSnapshotSeries(orchestratorIds, range) {
  const idsKey = useMemo(
    () => [...orchestratorIds].sort((a, b) => a - b).join(','),
    [orchestratorIds]
  );
  const [state, setState] = useState({ byId: {}, loading: false });

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').map(Number) : [];
    if (!ids.length) {
      setState({ byId: {}, loading: false });
      return undefined;
    }

    let cancelled = false;
    setState((prev) => ({ byId: prev.byId, loading: true }));

    const now = Date.now();
    const startAt = range?.ms ? now - range.ms : null;

    // Un fallo aisla al orquestador que lo sufrio: el resto de la tabla sigue
    // siendo util, y la fila afectada dice que se rompio.
    Promise.all(ids.map((id) => metricsApi
      .getSnapshots(id, { startAt, endAt: now, limit: 5000 })
      .then((data) => [id, { snapshots: Array.isArray(data) ? data : [], error: null }])
      .catch((err) => [id, { snapshots: [], error: err?.message || 'Error cargando metricas' }])))
      .then((entries) => {
        if (cancelled) return;
        setState({ byId: Object.fromEntries(entries), loading: false });
      });

    return () => { cancelled = true; };
  }, [idsKey, range?.id, range?.ms]);

  return state;
}
