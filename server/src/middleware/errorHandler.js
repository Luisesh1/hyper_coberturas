const logger = require('../services/logger.service');
const { buildErrorEnvelope } = require('../shared/platform/http/response-envelope');

/**
 * Middleware global de manejo de errores para Express.
 * Captura errores lanzados desde rutas y middlewares.
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const rawMessage = err.message || 'Error interno del servidor';

  logger.error('http_error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    code: err.code || 'UNHANDLED_ERROR',
    message: rawMessage,
  });

  // En producción, no exponer mensajes internos en errores 500
  const IS_PROD = process.env.NODE_ENV === 'production';
  const safeMessage = (IS_PROD && status >= 500)
    ? 'Error interno del servidor'
    : rawMessage;

  const shouldExposeDetails = Boolean(err.details) && (!IS_PROD || status < 500);

  res.status(status).json(buildErrorEnvelope({
    message: safeMessage,
    code: err.code || 'UNHANDLED_ERROR',
    requestId: req.requestId,
    details: shouldExposeDetails ? err.details : null,
    stack: !IS_PROD ? err.stack : null,
  }));
}

/**
 * Middleware para rutas no encontradas.
 */
function notFound(req, res, next) {
  const err = new Error(`Ruta no encontrada: ${req.method} ${req.originalUrl}`);
  err.status = 404;
  next(err);
}

module.exports = { errorHandler, notFound };
