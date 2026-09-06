/**
 * orchestrator-tag.service.js
 *
 * Resuelve "de que orquestador es esto" a partir del protected pool, para que
 * TODA notificacion de Telegram que hable de un LP orquestado lleve el id del
 * orquestador dentro del mensaje.
 *
 * El problema que resuelve: los mensajes de cobertura (hedge) y los bloqueos
 * delta-neutral nombran la proteccion (`#19`) o el activo (`ETH`), pero con
 * varios orquestadores corriendo a la vez eso no basta para saber cual pide
 * atencion. El id del orquestador es el mismo que se lee en su tarjeta, asi
 * que sirve de puente entre la alerta y la UI.
 *
 * El vinculo vive en `lp_orchestrators.active_protected_pool_id`, asi que la
 * resolucion es una query. Como las notificaciones pueden llegar en rafagas
 * (un bloqueo por ciclo), se cachea en memoria: TTL largo para los aciertos
 * (el vinculo casi no cambia) y corto para los fallos, para que un LP recien
 * creado no quede sin etiqueta durante minutos.
 */

const orchestratorRepository = require('../repositories/lp-orchestrator.repository');
const logger = require('./logger.service');

const HIT_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 30 * 1000;

const cache = new Map(); // `${userId}:${protectedPoolId}` -> { tag, expiresAt }

function cacheKey(userId, protectedPoolId) {
  return `${userId}:${protectedPoolId}`;
}

/**
 * @returns {Promise<{id:number,name:string}|null>}
 */
async function resolveByProtectedPoolId(userId, protectedPoolId, {
  repository = orchestratorRepository,
} = {}) {
  const uid = Number(userId);
  const poolId = Number(protectedPoolId);
  if (!Number.isFinite(uid) || !Number.isFinite(poolId) || uid <= 0 || poolId <= 0) {
    return null;
  }

  const key = cacheKey(uid, poolId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.tag;

  let tag = null;
  try {
    tag = await repository.findIdentityByProtectedPoolId(uid, poolId);
  } catch (err) {
    // Nunca romper un envio por no poder etiquetarlo: el mensaje sin id sigue
    // siendo mejor que ningun mensaje.
    logger.warn('orchestrator_tag_resolve_failed', {
      userId: uid,
      protectedPoolId: poolId,
      error: err.message,
    });
    return null;
  }

  cache.set(key, {
    tag: tag || null,
    expiresAt: Date.now() + (tag ? HIT_TTL_MS : MISS_TTL_MS),
  });
  return tag || null;
}

/**
 * Etiqueta corta para el cuerpo del mensaje: `#12 · Nombre`.
 */
function formatTag(tag) {
  if (!tag || tag.id == null) return null;
  return tag.name ? `#${tag.id} · ${tag.name}` : `#${tag.id}`;
}

function invalidate(userId, protectedPoolId) {
  if (protectedPoolId == null) {
    const prefix = `${Number(userId)}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
    return;
  }
  cache.delete(cacheKey(Number(userId), Number(protectedPoolId)));
}

function clearCache() {
  cache.clear();
}

module.exports = {
  resolveByProtectedPoolId,
  formatTag,
  invalidate,
  clearCache,
};
