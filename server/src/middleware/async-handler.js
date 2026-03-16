/**
 * Wrapper para route handlers async.
 * Elimina la necesidad de try/catch + next(err) repetitivo.
 *
 * Uso: router.get('/', asyncHandler(async (req, res) => { ... }))
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
