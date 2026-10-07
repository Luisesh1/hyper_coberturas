import { formatUnits } from 'viem';
import { formatNumber } from '../../utils/formatters';

export const PROFILE_OPTIONS = [
  { id: 'low', label: 'Bajo', description: 'La comisión mínima con la que la tx aún entra. Si se atasca, puedes acelerarla.' },
  { id: 'medium', label: 'Medio', description: 'Aguanta subidas moderadas del gas sin atascarse.' },
  { id: 'high', label: 'Alto', description: 'Prioridad y margen amplios para momentos de congestión.' },
];

export const ROLE_LABELS = {
  destination: 'Destino',
  used: 'Se usa',
  excluded: 'Excluido',
  not_needed: 'No necesario',
  idle: 'Sin usar',
  gas_reserve: 'Reserva de gas',
  disabled: 'Desactivado',
  no_price: 'Sin precio',
  no_route: 'Sin ruta',
};

export const STEP_STATUS_LABELS = {
  pending: 'Pendiente',
  signed: 'Enviado, esperando bloque',
  source_confirmed: 'En camino',
  delivered: 'Entregado',
  failed: 'Falló',
  refunded: 'Reembolsado',
  skipped: 'Saltado',
};

const USD = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `$${USD.format(Number(value))}`;
}

export function formatPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${formatNumber(Number(value), 2)} %`;
}

export function formatAmount(raw, decimals, maxDigits = 6) {
  try {
    return formatNumber(Number(formatUnits(BigInt(raw || 0), Number(decimals ?? 18))), maxDigits);
  } catch {
    return '—';
  }
}

export function providerLabel(provider) {
  if (provider === 'lifi') return 'Li.Fi';
  if (provider === 'across') return 'Across directo';
  return provider || '—';
}
