/**
 * Helpers reutilizables para parsear y validar parámetros de ruta / query.
 *
 * Al lanzar ValidationError, el asyncHandler + errorHandler middleware
 * produce automáticamente la respuesta con buildErrorEnvelope.
 */

const { ValidationError } = require('../errors/app-error');

/**
 * Parsea un parámetro de ruta como entero positivo.
 * Lanza ValidationError si no es válido.
 */
function requireIntParam(req, paramName) {
  const raw = req.params[paramName];
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    throw new ValidationError(`${paramName} inválido: ${raw}`);
  }
  return parsed;
}

/**
 * Parsea un parámetro de query como entero positivo opcional.
 * Retorna null si no está presente. Lanza ValidationError si está presente pero inválido.
 */
function optionalIntQuery(req, queryName) {
  if (req.query[queryName] == null || req.query[queryName] === '') return null;
  const parsed = Number(req.query[queryName]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError(`${queryName} inválido`);
  }
  return parsed;
}

module.exports = { requireIntParam, optionalIntQuery };
