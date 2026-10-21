// Formato compartido por chips y tooltip de superposiciones.
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TF_LABEL = { '1d': '1D', '1w': '1W', '1M': '1M' };
const DAILY = new Set(['1d', '1w', '1M']);

function decimalsFor(abs) {
  if (abs >= 10_000) return 0;
  if (abs >= 1_000) return 1;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function formatOverlayValue(value, { usd = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const d = decimalsFor(Math.abs(value));
  const text = value.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  return usd ? `$${text}` : text;
}

export function formatOverlayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '';
  const abs = Math.abs(pct);
  const text = abs.toFixed(abs > 0 && abs < 0.1 ? 2 : 1);
  const sign = Number(text) === 0 ? '' : pct > 0 ? '+' : '−';
  return `${sign}${text} %`;
}

export function formatAgo(hours) {
  if (hours == null || !Number.isFinite(hours)) return '';
  if (hours >= 1) return `${Math.round(hours)} h`;
  return `${Math.max(1, Math.round(hours * 60))} min`;
}

const pad = (n) => String(n).padStart(2, '0');

// El eje de tiempo del gráfico está en UTC: el tooltip también.
export function formatCandleTime(sec, timeframe) {
  const d = new Date(sec * 1000);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const when = DAILY.has(timeframe)
    ? `${day} ${d.getUTCFullYear()}`
    : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return timeframe ? `${when} · vela ${TF_LABEL[timeframe] ?? timeframe}` : when;
}

export const isOptionId = (id) => typeof id === 'string' && id.startsWith('option:');
