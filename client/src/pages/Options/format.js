// Formato numérico del módulo de Opciones (es-ES, separador de miles siempre).

const MINUS = '−';

function isNum(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

export function fmtNum(value, decimals = 2) {
  if (!isNum(value)) return '—';
  const text = Number(value).toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: 'always',
  });
  return text.replace('-', MINUS);
}

// Con signo explícito (+ / −), para P&L, griegas y primas.
export function fmtSigned(value, decimals = 2) {
  if (!isNum(value)) return '—';
  const n = Number(value);
  const body = fmtNum(Math.abs(n), decimals);
  if (Number(body.replace(/\./g, '').replace(',', '.')) === 0) return body;
  return (n > 0 ? '+' : MINUS) + body;
}

// Decimales para un precio según su magnitud: 1180 → 0, 62,4 → 1,
// 3,25 → 2, 0,0012 → 5.
export function priceDecimals(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n) || n === 0) return 2;
  if (n >= 100) return 0;
  if (n >= 10) return 1;
  if (n >= 1) return 2;
  return Math.min(6, 2 - Math.floor(Math.log10(n)));
}

export function fmtPrice(value) {
  if (!isNum(value)) return '—';
  return fmtNum(value, priceDecimals(value));
}

// Strikes: enteros salvo en subyacentes baratos (XRP, DOGE).
export function fmtStrike(value) {
  if (!isNum(value)) return '—';
  const n = Math.abs(Number(value));
  const decimals = n >= 100 ? 0 : Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(n || 1))));
  return fmtNum(value, decimals);
}

export function fmtSpot(value) {
  if (!isNum(value)) return '—';
  const n = Math.abs(Number(value));
  return fmtNum(value, n >= 1000 ? 2 : priceDecimals(value));
}

// IV: el backend la da como fracción (0,52) o como porcentaje (52); se
// normaliza a porcentaje.
export function fmtIv(value) {
  if (!isNum(value)) return '—';
  const n = Number(value);
  const pct = Math.abs(n) <= 5 ? n * 100 : n;
  return `${fmtNum(pct, 1)} %`;
}

export function fmtPct(value, decimals = 2) {
  if (!isNum(value)) return '—';
  return `${fmtSigned(value, decimals)} %`;
}

export function toneOf(value) {
  if (!isNum(value)) return 'neutral';
  const n = Number(value);
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'neutral';
}

const DATE_FMT = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

export function fmtDateTime(ms) {
  if (!isNum(ms)) return '—';
  return new Date(Number(ms)).toLocaleString('es-ES', DATE_FMT).replace('.', '');
}
