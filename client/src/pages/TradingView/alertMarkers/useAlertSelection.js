import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alertsApi, settingsApi } from '../../../services/api';
import { addAlert, removeAlert, toggleAlertHidden, setAlertColor } from './markerModel';

const asList = (res) => (Array.isArray(res) ? res : Array.isArray(res?.alerts) ? res.alerts : []);

// Alertas elegidas para dibujar en el gráfico. Cada cambio se aplica al
// momento y se guarda en segundo plano (guardados en serie); si falla, se
// vuelve al último estado confirmado. Los items cuyo alertId ya no existe se
// conservan (el backtest los marca `deleted`).
// Si la selección guardada no pudo cargarse (`loadError`), los cambios son no-ops
// para no pisarla.
export function useAlertSelection() {
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [alertsError, setAlertsError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const itemsRef = useRef(items);
  const confirmedRef = useRef(items);
  const savingRef = useRef(false);
  const loadedRef = useRef(false);
  const aliveRef = useRef(true);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [a, s] = await Promise.allSettled([alertsApi.list(), settingsApi.getChartAlertMarkers()]);
      if (cancelled) return;
      if (a.status === 'fulfilled') { setAlerts(asList(a.value)); setAlertsError(null); } else setAlertsError(a.reason?.message || 'error');
      if (s.status === 'fulfilled') {
        const list = Array.isArray(s.value?.items) ? s.value.items : [];
        itemsRef.current = list;
        confirmedRef.current = list;
        loadedRef.current = true;
        setItems(list);
        setLoadError(null);
      } else {
        loadedRef.current = false;
        setLoadError(s.reason?.message || 'error');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; aliveRef.current = false; };
  }, [reloadTick]);

  const alertsById = useMemo(() => {
    const out = {};
    for (const a of alerts) out[a.id] = a;
    return out;
  }, [alerts]);

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (itemsRef.current !== confirmedRef.current) {
        const target = itemsRef.current;
        try {
          await settingsApi.saveChartAlertMarkers({ items: target });
          confirmedRef.current = target;
          if (aliveRef.current) setSaveError(null);
        } catch (err) {
          itemsRef.current = confirmedRef.current;
          if (aliveRef.current) {
            setItems(confirmedRef.current);
            setSaveError(err?.message || 'error');
          }
          return;
        }
      }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const apply = useCallback((fn) => {
    if (!loadedRef.current) return;
    const next = fn(itemsRef.current);
    if (next === itemsRef.current) return;
    itemsRef.current = next;
    setItems(next);
    flush();
  }, [flush]);

  const add = useCallback((id) => apply((s) => addAlert(s, id)), [apply]);
  const remove = useCallback((id) => apply((s) => removeAlert(s, id)), [apply]);
  const toggleHidden = useCallback((id) => apply((s) => toggleAlertHidden(s, id)), [apply]);
  const setColor = useCallback((id, c) => apply((s) => setAlertColor(s, id, c)), [apply]);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  const alertsStatus = loading ? 'loading' : alertsError ? 'error' : 'ready';
  return {
    items, alerts, alertsById, loading, alertsStatus, alertsError, loadError, saveError,
    add, remove, toggleHidden, setColor, reload,
  };
}

export default useAlertSelection;
