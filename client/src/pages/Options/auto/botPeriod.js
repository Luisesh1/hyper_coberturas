// Periodo de las estadísticas del detalle del bot («Todo», 7 d, 3 d o desde
// una fecha local). Se recuerda por bot en localStorage; si falla, «Todo».

const DAY_MS = 86400000;
const KEY = (botId) => `options.bot.period.${botId}`;

export const PERIOD_ALL = { kind: 'all' };

export const PERIOD_OPTIONS = [
  { kind: 'all', label: 'Todo' },
  { kind: 'd7', label: '7 d' },
  { kind: 'd3', label: '3 d' },
  { kind: 'since', label: 'Desde…' },
];

const DAYS = { d7: 7, d3: 3 };

// Inicio (00:00 local) de un día «YYYY-MM-DD», en ms; null si no es válido.
export function startOfLocalDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function toDateInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// `since` en ms que se envía al servidor (null = sin filtro).
export function periodSince(period, now = Date.now()) {
  if (!period) return null;
  if (DAYS[period.kind]) return now - DAYS[period.kind] * DAY_MS;
  if (period.kind === 'since' && Number.isFinite(period.since)) return period.since;
  return null;
}

// Texto corto del periodo activo; null con «Todo».
export function periodLabel(period) {
  if (!period || period.kind === 'all') return null;
  if (DAYS[period.kind]) return `${DAYS[period.kind]} d`;
  if (period.kind === 'since' && Number.isFinite(period.since)) {
    const text = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(new Date(period.since)).replace('.', '');
    return `desde ${text}`;
  }
  return null;
}

export function loadPeriod(botId) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY(botId)));
    if (raw?.kind === 'd7' || raw?.kind === 'd3') return { kind: raw.kind };
    if (raw?.kind === 'since' && Number.isFinite(raw.since)) return { kind: 'since', since: raw.since };
  } catch { /* sin almacenamiento o dato corrupto: Todo */ }
  return PERIOD_ALL;
}

export function savePeriod(botId, period) {
  try { window.localStorage.setItem(KEY(botId), JSON.stringify(period)); } catch { /* sin almacenamiento */ }
}
