/**
 * Antigüedad del ORQUESTADOR, en dos unidades como mucho.
 *
 * Vive aparte porque la muestran dos sitios —el encabezado del veredicto y el
 * panel de contabilidad plegado— y no pueden discrepar: "6d" arriba y "6d 4h"
 * abajo se leen como dos hechos distintos, que es justo lo que esta tarjeta
 * intenta no volver a hacer. Por eso tampoco reusa `formatDuration`, que
 * colapsa a una sola unidad.
 *
 * No es lo mismo que la edad del LP (`activeForMs`, en la barra de rango): un
 * orquestador sobrevive a varios LPs, y el P&L acumulado que acompaña a este
 * dato es el de todos ellos.
 */
export function formatOrchestratorAge(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const totalMinutes = Math.floor(numeric / 60_000);
  if (totalMinutes < 1) return '< 1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Edad en ms desde `createdAt`, o null si no hay fecha utilizable. */
export function orchestratorAgeMs(createdAt, now = Date.now()) {
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return null;
  const age = now - created;
  return age > 0 ? age : null;
}
