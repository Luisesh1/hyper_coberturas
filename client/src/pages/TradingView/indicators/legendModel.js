// Leyenda de indicadores sobre el gráfico. Lógica pura: el controlador sólo
// devuelve valores de los indicadores montados (visibles), así que los ocultos
// se añaden aquí para que la leyenda permita volver a mostrarlos.
import { INDICATORS } from './catalog';

// Una fila por indicador de la configuración, en su orden. `valueRows` es la
// salida de `controller.getValuesAt(time)`.
export function buildIndicatorLegend(indicators, valueRows) {
  const byUid = new Map((valueRows || []).map((row) => [row.uid, row]));
  const legend = [];
  for (const ind of indicators || []) {
    if (!ind?.uid || !INDICATORS[ind.type]) continue;
    const hidden = ind.visible === false;
    const row = hidden ? null : byUid.get(ind.uid);
    legend.push({
      uid: ind.uid,
      type: ind.type,
      label: row?.label ?? INDICATORS[ind.type].label,
      params: row?.params ?? ind.params ?? {},
      hidden,
      values: row?.values ?? [],
    });
  }
  return legend;
}

export function toggleIndicatorVisible(indicators, uid) {
  if (!indicators.some((ind) => ind.uid === uid)) return indicators;
  return indicators.map((ind) => (
    ind.uid === uid ? { ...ind, visible: ind.visible === false } : ind
  ));
}
