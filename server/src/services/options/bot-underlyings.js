/**
 * Subyacentes de un bot por alertas. Un bot puede operar varios a la vez con
 * las mismas alertas (`params.underlyings`, 1–6, sin repetir); la columna
 * `underlying` vale el primero. Sin `params.underlyings` el bot opera solo
 * `strategy.underlying`, como siempre.
 *
 * Lo comparten el template `alert_signal`, el servicio de bots, el runner y
 * el backtest.
 */

const { ValidationError } = require('../../errors/app-error');
const { UNDERLYINGS } = require('./options-iv-recorder.service');

const MAX_BOT_UNDERLYINGS = 6;

/** Subyacentes que opera el bot (siempre al menos uno). */
function botUnderlyings(strategy) {
  const list = strategy?.params?.underlyings;
  if (Array.isArray(list) && list.length) return list.map((u) => String(u).toUpperCase());
  return strategy?.underlying ? [String(strategy.underlying).toUpperCase()] : [];
}

/**
 * Valida y normaliza la lista: mayúsculas, de `UNDERLYINGS`, sin repetir,
 * entre 1 y 6. `null`/`undefined` → null (el bot opera solo su subyacente).
 */
function normalizeUnderlyings(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new ValidationError('Subyacentes: debe ser una lista');
  if (!value.length) throw new ValidationError('Subyacentes: elige al menos uno');
  const list = value.map((u) => String(u ?? '').trim().toUpperCase());
  const unknown = list.find((u) => !UNDERLYINGS.includes(u));
  if (unknown !== undefined) {
    throw new ValidationError(`Subyacente no soportado: ${unknown || '(vacío)'}. Opciones: ${UNDERLYINGS.join(', ')}`);
  }
  if (new Set(list).size !== list.length) throw new ValidationError('Subyacentes: no repitas ninguno');
  if (list.length > MAX_BOT_UNDERLYINGS) throw new ValidationError(`Subyacentes: máximo ${MAX_BOT_UNDERLYINGS}`);
  return list;
}

module.exports = { botUnderlyings, normalizeUnderlyings, MAX_BOT_UNDERLYINGS };
