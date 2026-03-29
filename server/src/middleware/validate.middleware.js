const { ValidationError } = require('../errors/app-error');

/**
 * Middleware factory: valida req.body contra un schema zod.
 * Uso: router.post('/', validate(mySchema), handler)
 */
function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const messages = result.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`
      );
      return next(new ValidationError(messages.join('; ')));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Middleware factory: valida req.query contra un schema zod.
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const messages = result.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`
      );
      return next(new ValidationError(messages.join('; ')));
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validate, validateQuery };
