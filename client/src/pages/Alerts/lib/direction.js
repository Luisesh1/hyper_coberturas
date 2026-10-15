/**
 * Dirección de la señal de una alerta: alcista, bajista o neutral.
 * Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md (A).
 *
 * La dirección nunca se distingue solo por color: cada una tiene su forma
 * (triángulo arriba, triángulo abajo, barra) en `DirectionIcon`.
 */

export const DIRECTIONS = ['bullish', 'bearish', 'neutral'];
export const DEFAULT_DIRECTION = 'neutral';

export const DIRECTION_META = {
  bullish: {
    label: 'Alcista',
    plural: 'Alcistas',
    hint: 'Señal de compra / subida',
    mobileHint: 'Señal de subida · los bots abren a favor',
    telegram: '🟢 ALCISTA · ',
  },
  bearish: {
    label: 'Bajista',
    plural: 'Bajistas',
    hint: 'Señal de venta / bajada',
    mobileHint: 'Señal de bajada · los bots abren a favor',
    telegram: '🔴 BAJISTA · ',
  },
  neutral: {
    label: 'Neutral',
    plural: 'Neutrales',
    hint: 'Solo aviso, no opera',
    mobileHint: 'Solo aviso · ningún bot la opera',
    // Igual que el servidor: neutral conserva el encabezado de siempre.
    telegram: '🔔 ',
  },
};

export const DIRECTION_FILTERS = [
  { key: 'all', label: 'Todas' },
  ...DIRECTIONS.map((d) => ({ key: d, label: DIRECTION_META[d].plural })),
];

export function normalizeDirection(value) {
  return DIRECTIONS.includes(value) ? value : DEFAULT_DIRECTION;
}

export function matchesDirectionFilter(alert, filter) {
  if (!filter || filter === 'all') return true;
  return normalizeDirection(alert?.direction) === filter;
}

// Primera línea del mensaje de Telegram (espejo de `buildAlertMessage`).
export function telegramTitle(direction, name) {
  return `${DIRECTION_META[normalizeDirection(direction)].telegram}${name || 'Sin nombre'}`;
}

const MODE_LABELS = { paused: 'Pausada', shadow: 'Sombra', live: 'Real' };
export function botModeLabel(mode) {
  return MODE_LABELS[mode] || mode || '';
}

// Qué abre un bot con esta dirección según su estructura.
export function botOpensLabel(structure, direction) {
  if (direction === 'bullish') return structure === 'sell_against' ? 'vende puts' : 'abre calls';
  if (direction === 'bearish') return structure === 'sell_against' ? 'vende calls' : 'abre puts';
  return 'no opera';
}
