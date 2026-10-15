// Formato de números y fechas de las pestañas de automatización (es-ES).
// Los negativos llevan el signo menos tipográfico (−) como en el diseño.

const MINUS = '−';

function grouping() {
  // es-ES no agrupa los números de 4 cifras por defecto (1020 y no 1.020).
  // 'always' existe en los motores modernos; si no, cae al booleano.
  try {
    new Intl.NumberFormat('es-ES', { useGrouping: 'always' }).format(1000);
    return 'always';
  } catch {
    return true;
  }
}
const GROUPING = grouping();

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(value, { decimals = 2, sign = false, minDecimals } = {}) {
  const n = toNumber(value);
  if (n === null) return '—';
  const text = new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: minDecimals ?? decimals,
    maximumFractionDigits: decimals,
    useGrouping: GROUPING,
  }).format(Math.abs(n));
  const isZero = Number(text.replace(/\./g, '').replace(',', '.')) === 0;
  if (n < 0 && !isZero) return `${MINUS}${text}`;
  if (sign && n > 0 && !isZero) return `+${text}`;
  return text;
}

export const formatUsdt = (value, opts = {}) => formatNumber(value, { decimals: 2, ...opts });

export function formatPct(value, { decimals = 1, sign = false } = {}) {
  const n = toNumber(value);
  if (n === null) return '—';
  return `${formatNumber(n, { decimals, sign })} %`;
}

// Clase de tono para un P&L: positivo / negativo / neutro.
export function tone(value) {
  const n = toNumber(value);
  if (n === null || n === 0) return 'neutral';
  return n > 0 ? 'pos' : 'neg';
}

// Acepta ms, segundos o ISO.
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad = (n) => String(n).padStart(2, '0');

// «14 oct 08:15» (hora local).
export function formatDateTime(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// «14 oct».
export function formatDay(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;
}

// «oct 2025».
export function formatMonthYear(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Lee la primera clave definida entre varias grafías (camelCase / snake_case).
export function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}
