/**
 * auth.middleware.js
 *
 * Middlewares de autenticación y autorización JWT.
 *
 * authenticate        — verifica el token y agrega req.user
 * requireSuperuser    — solo permite acceso a superusers
 * requireSelfOrSuper  — permite al propio usuario o a superusers
 */

const jwt    = require('jsonwebtoken');
const config = require('../config');
const { AuthError, ForbiddenError } = require('../errors/app-error');

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return next(new AuthError('Token requerido'));
  }

  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch {
    return next(new AuthError('Token inválido o expirado'));
  }
}

function requireSuperuser(req, res, next) {
  if (req.user?.role !== 'superuser') {
    return next(new ForbiddenError('Acceso restringido a superusuarios'));
  }
  next();
}

// Permite al propio usuario (por :id) o a superusers
function requireSelfOrSuper(req, res, next) {
  const targetId = parseInt(req.params.id, 10);
  if (req.user?.role === 'superuser' || req.user?.userId === targetId) {
    return next();
  }
  return next(new ForbiddenError('Sin permisos para esta operación'));
}

module.exports = { authenticate, requireSuperuser, requireSelfOrSuper };
