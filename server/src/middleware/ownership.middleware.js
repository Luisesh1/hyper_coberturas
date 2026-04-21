/**
 * ownership.middleware.js
 *
 * Middleware genérico para verificar que el usuario autenticado sea
 * dueño del recurso referenciado por `:id` (u otro param). Evita IDOR:
 * usuario A operando recursos de usuario B.
 *
 * Modo de uso:
 *   const { requireOwnership } = require('../middleware/ownership.middleware');
 *   router.delete(
 *     '/:id',
 *     authenticate,
 *     requireOwnership({ loader: (userId, id) => repo.getById(userId, id) }),
 *     handler,
 *   );
 *
 * `loader(userId, id)` debe devolver el recurso si pertenece al usuario
 * o `null`/`undefined` si no existe o no es suyo. Los superusers pueden
 * opcionalmente bypassear si `allowSuperuser: true` (default true).
 */

const { ForbiddenError, NotFoundError } = require('../errors/app-error');

function requireOwnership({ loader, param = 'id', attach = null, allowSuperuser = true } = {}) {
  if (typeof loader !== 'function') {
    throw new Error('requireOwnership: `loader` es requerido');
  }

  return async function ownershipMiddleware(req, res, next) {
    try {
      if (!req.user) {
        return next(new ForbiddenError('No autenticado'));
      }
      const raw = req.params?.[param];
      if (raw == null || raw === '') {
        return next(new NotFoundError('Recurso no encontrado'));
      }
      const id = /^\d+$/.test(String(raw)) ? Number(raw) : raw;

      // Superuser bypass (si está habilitado): aún cargamos el recurso
      // para 404 consistente, pero sin validar ownership.
      const userId = req.user.userId;
      const resource = await loader(userId, id, req);

      if (!resource) {
        // Si es superuser y allowSuperuser=true, intentar sin filtrar por user
        if (allowSuperuser && req.user.role === 'superuser' && loader.length >= 4) {
          const resourceSu = await loader(null, id, req, true);
          if (!resourceSu) return next(new NotFoundError('Recurso no encontrado'));
          if (attach) req[attach] = resourceSu;
          return next();
        }
        return next(new NotFoundError('Recurso no encontrado'));
      }

      if (attach) req[attach] = resource;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireOwnership };
