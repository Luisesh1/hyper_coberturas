import { useEffect, useMemo } from 'react';
import { useAlertSelection } from './useAlertSelection';
import { useAlertBacktest } from './useAlertBacktest';
import { countFirings } from './markerModel';

// Datos de las marcas de alertas de una vista (uno por página): selección
// guardada, backtest del rango `ranges`, contadores, colores y avisos.
// El dibujo por gráfico lo hace useAlertMarkerLayer.
export function useAlertMarkerData({ asset, ranges, enabled = true, cutoffMs = Infinity, notify }) {
  const selection = useAlertSelection({ enabled });
  const { items, alertsById, alertsStatus, saveError, loadError } = selection;

  const backtest = useAlertBacktest({ asset, items, alertsById, ranges, enabled, alertsStatus });
  const { eventsByAlert } = backtest;

  const countsByAlert = useMemo(() => countFirings(eventsByAlert, cutoffMs), [eventsByAlert, cutoffMs]);
  const colorsById = useMemo(() => Object.fromEntries(items.map((i) => [i.alertId, i.color])), [items]);

  useEffect(() => {
    if (saveError && enabled) notify?.('error', `No se pudo guardar la selección de alertas: ${saveError}`);
  }, [saveError, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loadError && enabled) notify?.('alert', `No se pudo cargar tu selección de alertas: ${loadError}`);
  }, [loadError, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    selection,
    eventsByAlert,
    statusByAlert: backtest.statusByAlert,
    retry: backtest.retry,
    countsByAlert,
    colorsById,
  };
}

export default useAlertMarkerData;
