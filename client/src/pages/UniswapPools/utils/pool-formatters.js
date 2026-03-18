import { formatNumber, formatDuration } from '../../../utils/formatters';

export function shortAddress(value) {
  if (!value) return '—';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function formatCompactUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${formatNumber(n, 2)}`;
}

export function formatUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return `$${formatNumber(n, 2)}`;
}

export function formatSignedUsd(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${formatNumber(Math.abs(n), 2)}`;
}

export function formatPercent(value) {
  if (value == null) return 'N/A';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatNumber(n, Math.abs(n) >= 10 ? 2 : 4)}%`;
}

export function formatPercentRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
  return `${formatNumber(n * 100, 2)}%`;
}

export function formatPrice(value, baseSymbol, quoteSymbol) {
  if (value == null) return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'N/A';
  return `${formatNumber(numeric, numeric >= 100 ? 2 : 6)} ${quoteSymbol}/${baseSymbol}`;
}

export function formatCompactPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 10000) return formatNumber(n, 0);
  if (n >= 100) return formatNumber(n, 2);
  if (n >= 1) return formatNumber(n, 4);
  return formatNumber(n, 6);
}

export function formatRelativeTimestamp(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return 'sin actualizar';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return 'hace instantes';
  return `hace ${formatDuration(diff)}`;
}

export function roundUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
