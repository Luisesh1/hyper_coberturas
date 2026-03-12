const logger = require('../services/logger.service');

/**
 * Middleware global de manejo de errores para Express.
 * Captura errores lanzados desde rutas y middlewares.
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Error interno del servidor';

  logger.error('http_error', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    code: err.code || 'UNHANDLED_ERROR',
    message,
  });

  res.status(status).json({
    success: false,
    error: message,
    code: err.code || 'UNHANDLED_ERROR',
    requestId: req.requestId,
    ...(err.details ? { details: err.details } : {}),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
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
