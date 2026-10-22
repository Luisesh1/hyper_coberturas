import { useEffect, useMemo, useRef } from 'react';
import { useAlertMarkerData } from './useAlertMarkerData';
import { useAlertMarkerLayer } from './useAlertMarkerLayer';
import { alertRanges, replayCutoffMs } from './markerModel';

// Pegamento de las marcas de alertas del gráfico principal: selección, backtest,
// marcas en la serie de velas, contadores y avisos. En replay solo se ven los
// disparos con evalTime ≤ instante actual del replay.
export function useChartAlertMarkers({ asset, timeframe, candlesRef, candleSeriesRef, candleCount, replay, notify }) {
  // candlesRef se reasigna al cargar y se muta en sitio en replay: la identidad
  // del array + candleCount + estado del replay marcan cuándo recalcular.
  const chartCandles = candlesRef.current;
  const replayActive = !!replay?.active;
  const replayAnchor = replay?.anchor ?? null;

  // En replay el rango baja hasta las velas del replay pero el borde derecho
  // sigue siendo el de la vista en vivo: el replay avanza hacia él.
  // El borde en vivo se recuerda en un efecto (no durante el render); el replay
  // siempre arranca después de haber pintado la vista en vivo.
  const chartRanges = useMemo(
    () => alertRanges(chartCandles, timeframe),
    [chartCandles, candleCount, timeframe, replayActive, replayAnchor], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const liveToRef = useRef(null);
  useEffect(() => {
    if (!replayActive && chartRanges.length) liveToRef.current = chartRanges[0].toMs;
  }, [chartRanges, replayActive]);
  const ranges = useMemo(() => {
    if (!replayActive || !chartRanges.length) return chartRanges;
    const r = chartRanges[0];
    return [{ fromMs: r.fromMs, toMs: Math.max(r.toMs, liveToRef.current ?? r.toMs) }];
  }, [chartRanges, replayActive]);

  const cutoffMs = replayCutoffMs(replay);
  const data = useAlertMarkerData({ asset, ranges, enabled: true, cutoffMs, notify });
  const { selection, eventsByAlert } = data;
  const { timeline } = useAlertMarkerLayer({
    seriesRef: candleSeriesRef,
    eventsByAlert,
    items: selection.items,
    alertsById: selection.alertsById,
    timeframe,
    chartCandles,
    cutoffMs,
    version: `${candleCount}|${replayActive}|${replayAnchor}`,
  });

  return {
    selection,
    statusByAlert: data.statusByAlert,
    retry: data.retry,
    countsByAlert: data.countsByAlert,
    colorsById: data.colorsById,
    timeline,
    cutoffMs,
  };
}

export default useChartAlertMarkers;
