import { useMemo } from 'react';
import { useSeriesAlertMarkers } from './useSeriesAlertMarkers';
import { buildMarkers, markerTimeline } from './markerModel';

// Marcas de un gráfico: las dibuja en `seriesRef` según su temporalidad y sus
// velas, y devuelve la línea temporal para la tarjeta de detalle.
// `version` fuerza el recálculo cuando las velas se mutan en sitio (replay).
export function useAlertMarkerLayer({
  seriesRef, eventsByAlert, items, alertsById, timeframe, chartCandles, cutoffMs = Infinity, version,
}) {
  const deps = [eventsByAlert, items, alertsById, timeframe, chartCandles, cutoffMs, version];
  const markers = useMemo(
    () => buildMarkers({ eventsByAlert, items, alertsById, chartTf: timeframe, chartCandles, cutoffMs }),
    deps, // eslint-disable-line react-hooks/exhaustive-deps
  );
  const timeline = useMemo(
    () => markerTimeline(eventsByAlert, items, timeframe, chartCandles, cutoffMs),
    deps, // eslint-disable-line react-hooks/exhaustive-deps
  );
  useSeriesAlertMarkers({ seriesRef, markers });
  return { markers, timeline };
}

export default useAlertMarkerLayer;
