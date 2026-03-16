/**
 * Shared JSON serialization utilities.
 * Used by backtesting, strategy, indicator, and bot forms.
 */

export function safeJsonParse(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return fallback; }
}

export function stringifyJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
