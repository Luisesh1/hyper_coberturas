import { useEffect, useMemo, useRef } from 'react';
import { useAlertSelection } from './useAlertSelection';
import { useAlertBacktest } from './useAlertBacktest';
import { useSeriesAlertMarkers } from './useSeriesAlertMarkers';
import { alertRanges, buildMarkers, countFirings, markerTimeline, replayCutoffMs } from './markerModel';

// Pegamento de las marcas de alertas del gráfico principal: selección, backtest,
// marcas en la serie de velas, contadores y avisos. En replay solo se ven los
// disparos con evalTime ≤ instante actual del replay.
export function useChartAlertMarkers({ asset, timeframe, candlesRef, candleSeriesRef, candleCount, replay, notify }) {
  const selection = useAlertSelection();
  const { items, alertsById, alertsStatus, saveError, loadError } = selection;

  // candlesRef se reasigna al cargar y se muta en sitio en replay: la identidad
  // del array + candleCount + estado del replay marcan cuándo recalcular.
  const chartCandles = candlesRef.current;
  const replayActive = !!replay?.active;
  const replayAnchor = replay?.anchor ?? null;

  // En replay el rango baja hasta las velas del replay pero el borde derecho
  // sigue siendo el de la vista en vivo: el replay avanza hacia él.
  const liveToRef = useRef(null);
  const ranges = useMemo(() => {
    const r = alertRanges(chartCandles, timeframe);
    if (!r.length) return r;
    if (!replayActive) { liveToRef.current = r[0].toMs; return r; }
    return [{ fromMs: r[0].fromMs, toMs: Math.max(r[0].toMs, liveToRef.current ?? r[0].toMs) }];
  }, [chartCandles, candleCount, timeframe, replayActive, replayAnchor]); // eslint-disable-line react-hooks/exhaustive-deps

  const backtest = useAlertBacktest({ asset, items, alertsById, ranges, enabled: true, alertsStatus });
  const { eventsByAlert } = backtest;

  const cutoffMs = replayCutoffMs(replay);
  const markerDeps = [eventsByAlert, items, alertsById, timeframe, chartCandles, candleCount, cutoffMs, replayActive, replayAnchor];
  const markers = useMemo(
    () => buildMarkers({ eventsByAlert, items, alertsById, chartTf: timeframe, chartCandles, cutoffMs }),
    markerDeps, // eslint-disable-line react-hooks/exhaustive-deps
  );
  const timeline = useMemo(
    () => markerTimeline(eventsByAlert, items, timeframe, chartCandles, cutoffMs),
    markerDeps, // eslint-disable-line react-hooks/exhaustive-deps
  );
  useSeriesAlertMarkers({ seriesRef: candleSeriesRef, markers });

  const countsByAlert = useMemo(() => countFirings(eventsByAlert, cutoffMs), [eventsByAlert, cutoffMs]);
  const colorsById = useMemo(() => Object.fromEntries(items.map((i) => [i.alertId, i.color])), [items]);

  useEffect(() => {
    if (saveError) notify?.('error', `No se pudo guardar la selección de alertas: ${saveError}`);
  }, [saveError]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loadError) notify?.('alert', `No se pudo cargar tu selección de alertas: ${loadError}`);
  }, [loadError]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    selection,
    statusByAlert: backtest.statusByAlert,
    retry: backtest.retry,
    countsByAlert,
    colorsById,
    timeline,
    cutoffMs,
  };
}

export default useChartAlertMarkers;
