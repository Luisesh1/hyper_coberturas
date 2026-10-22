import { useEffect, useRef } from 'react';
import { createSeriesMarkers } from 'lightweight-charts';

// Mantiene un plugin de marcas por serie. Si la serie se recrea, vuelve a engancharlo.
export function useSeriesAlertMarkers({ seriesRef, markers }) {
  const pluginRef = useRef(null); // { series, plugin, markers }

  const detach = () => {
    const cur = pluginRef.current;
    pluginRef.current = null;
    if (!cur) return;
    try { cur.plugin.detach(); } catch { /* serie ya destruida */ }
  };

  useEffect(() => {
    const series = seriesRef?.current ?? null;
    if (pluginRef.current && pluginRef.current.series !== series) detach();
    if (!series) return;
    if (!pluginRef.current) {
      pluginRef.current = { series, plugin: createSeriesMarkers(series, []), markers: null };
    }
    const cur = pluginRef.current;
    if (cur.markers !== markers) {
      cur.plugin.setMarkers(markers || []);
      cur.markers = markers;
    }
  }); // barato: el chart puede recrear la serie sin que cambien las props

  useEffect(() => detach, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export default useSeriesAlertMarkers;
