/**
 * formatters.js — Shared UI formatting utilities
 */

export function shortAddress(value = '') {
  if (!value) return '—';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function formatNumber(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(numeric);
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp * 1000).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDuration(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const minutes = Math.max(1, Math.floor(numeric / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Formatea un timestamp (ms desde epoch) como "hace Xs/m/h/d" según la
 * distancia con `now`. Para fechas futuras muestra "en Xs/m/h". Valores
 * inválidos devuelven '—'.
 */
export function formatRelative(timestampMs, { now = Date.now() } = {}) {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const diffMs = now - ts;
  const absMs = Math.abs(diffMs);
  const future = diffMs < 0;
  const prefix = future ? 'en ' : 'hace ';

  if (absMs < 60_000) return `${prefix}${Math.max(1, Math.floor(absMs / 1000))}s`;
  if (absMs < 3_600_000) return `${prefix}${Math.floor(absMs / 60_000)}m`;
  if (absMs < 172_800_000) return `${prefix}${Math.floor(absMs / 3_600_000)}h`;
  return `${prefix}${Math.floor(absMs / 86_400_000)}d`;
}

/**
 * Formato absoluto detallado (para tooltips). Acepta ms o segundos
 * según flag `inSeconds`.
 */
export function formatAbsolute(timestamp, { inSeconds = false } = {}) {
  if (!timestamp) return '—';
  const ms = inSeconds ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}
