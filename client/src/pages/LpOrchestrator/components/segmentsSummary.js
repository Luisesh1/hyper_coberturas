import { formatSignedUsd } from '../../UniswapPools/utils/pool-formatters';
import { signTone } from './accountingBreakdown';

/** Formato puro de la lista de tramos (sin React ni red). */

const CLOSE_REASON_LABELS = {
  range_exit_below: 'Salió por abajo',
  range_exit_above: 'Salió por arriba',
  manual_rerange: 'Ajuste manual',
  capital_change: 'Cambio de capital',
  lp_closed: 'LP cerrado',
  policy_change: 'Cambio de cobertura',
  unknown: 'Sin registrar',
};

export function closeReasonLabel(reason) {
  return CLOSE_REASON_LABELS[reason] || CLOSE_REASON_LABELS.unknown;
}

function formatCoverage(coverage) {
  const pct = coverage?.avgPct;
  if (pct == null || !Number.isFinite(Number(pct))) return '—';
  return `${Math.round(Number(pct))}% cubierto`;
}

function formatPrice(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatSegmentDate(ts) {
  if (ts == null) return '—';
  return new Date(Number(ts)).toLocaleString('es-MX', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatTime(ts) {
  return new Date(Number(ts)).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function sameDay(a, b) {
  return new Date(Number(a)).toDateString() === new Date(Number(b)).toDateString();
}

function formatDates(segment) {
  if (segment.closedAt == null) return `desde ${formatSegmentDate(segment.openedAt)}`;
  const end = sameDay(segment.openedAt, segment.closedAt)
    ? formatTime(segment.closedAt)
    : formatSegmentDate(segment.closedAt);
  return `${formatSegmentDate(segment.openedAt)} → ${end}`;
}

export const DIFFERENCE_TITLE = 'Diferencia de reconstrucción';

export function isDifferenceSegment(segment) {
  return segment?.openReason === 'backfill_diff';
}

export function segmentRowModel(segment) {
  const net = Number(segment.accounting?.totalNetPnlUsd);
  if (isDifferenceSegment(segment)) {
    // Fila sintética de la reconstrucción: solo el importe, sin periodo ni rango.
    return {
      difference: true,
      title: DIFFERENCE_TITLE,
      netText: Number.isFinite(net) ? formatSignedUsd(net) : '—',
      netTone: signTone(net),
      approximate: false,
      live: false,
    };
  }
  let reason;
  if (segment.status === 'open') reason = 'En curso';
  else if (segment.status === 'closing') reason = 'Ajustando';
  else reason = closeReasonLabel(segment.closeReason);
  return {
    title: `#${segment.seq}`,
    dates: formatDates(segment),
    range: `${formatPrice(segment.rangeLowerPrice)} – ${formatPrice(segment.rangeUpperPrice)}`,
    reason,
    netText: Number.isFinite(net) ? formatSignedUsd(net) : '—',
    netTone: signTone(net),
    coverageText: formatCoverage(segment.coverage),
    approximate: segment.accuracy === 'approximate',
    live: segment.status !== 'closed',
  };
}

/** Distinta de cero a la precisión de céntimo (lo que se puede mostrar). */
export function hasReconstructionGap(differenceUsd) {
  const n = Number(differenceUsd);
  return Number.isFinite(n) && Math.abs(n) >= 0.005;
}
