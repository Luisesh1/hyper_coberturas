import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alertsApi, settingsApi } from '../../../services/api';
import { addAlert, removeAlert, toggleAlertHidden, setAlertColor } from './markerModel';

const asList = (res) => (Array.isArray(res) ? res : Array.isArray(res?.alerts) ? res.alerts : []);

// Alertas elegidas para dibujar en el gráfico. Cada cambio se aplica al
// momento y se guarda en segundo plano; si el guardado falla, se revierte.
// Los items cuyo alertId ya no existe se conservan (el backtest los marca `deleted`).
export function useAlertSelection() {
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    (async () => {
      const [a, s] = await Promise.allSettled([alertsApi.list(), settingsApi.getChartAlertMarkers()]);
      if (cancelled) return;
      if (a.status === 'fulfilled') setAlerts(asList(a.value));
      if (s.status === 'fulfilled' && Array.isArray(s.value?.items)) setItems(s.value.items);
      setLoading(false);
    })();
    return () => { cancelled = true; aliveRef.current = false; };
  }, []);

  const alertsById = useMemo(() => {
    const out = {};
    for (const a of alerts) out[a.id] = a;
    return out;
  }, [alerts]);

  const apply = useCallback((fn) => {
    const prev = itemsRef.current;
    const next = fn(prev);
    if (next === prev) return;
    itemsRef.current = next;
    setItems(next);
    Promise.resolve()
      .then(() => settingsApi.saveChartAlertMarkers({ items: next }))
      .catch(() => {
        // Sólo se revierte si nadie ha cambiado nada entretanto.
        if (itemsRef.current === next && aliveRef.current) {
          itemsRef.current = prev;
          setItems(prev);
        }
      });
  }, []);

  const add = useCallback((id) => apply((s) => addAlert(s, id)), [apply]);
  const remove = useCallback((id) => apply((s) => removeAlert(s, id)), [apply]);
  const toggleHidden = useCallback((id) => apply((s) => toggleAlertHidden(s, id)), [apply]);
  const setColor = useCallback((id, c) => apply((s) => setAlertColor(s, id, c)), [apply]);

  return { items, alerts, alertsById, loading, add, remove, toggleHidden, setColor };
}

export default useAlertSelection;
