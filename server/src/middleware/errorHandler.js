/**
 * Middleware global de manejo de errores para Express.
 * Captura errores lanzados desde rutas y middlewares.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Error interno del servidor';

  console.error(`[Error] ${req.method} ${req.path} -> ${status}: ${message}`);
  if (err.stack && process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  res.status(status).json({
    success: false,
    error: message,
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
