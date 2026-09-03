/** Formateo compartido por la franja de portafolio, las filas y la tarjeta. */

/**
 * Coercion numerica estricta. `Number()` no sirve sola: `Number(null)`,
 * `Number('')` y `Number(false)` valen 0, asi que una columna NULL de Postgres
 * llegaria a la UI como un cero legitimo. Aqui solo un numero real o una
 * cadena con contenido cuentan como dato; todo lo demas es NaN.
 */
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

export function fmtUsd(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtSignedUsd(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${fmtUsd(Math.abs(n))}`;
}

/** Compacto para columnas: $4,120 en vez de $4,120.00. */
export function fmtUsdCompact(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function fmtPct(value, digits = 2) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtDateTime(ms) {
  const d = new Date(toNumber(ms));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

/** `null` en vez de NaN: un dato ausente es un hueco, nunca un cero. */
export function finite(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
}
