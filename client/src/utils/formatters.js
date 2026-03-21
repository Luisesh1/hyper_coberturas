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
