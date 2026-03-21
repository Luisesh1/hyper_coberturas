/**
 * registry.factory.js
 *
 * Factory para crear registries in-memory con patrón Map + lazy build.
 * Cada registry mantiene una instancia por clave y soporta:
 *   - getOrCreate: obtiene o crea lazily
 *   - get: obtiene sin crear
 *   - getAll: lista todas las instancias
 *   - reload: destruye y recrea una instancia
 *   - destroy: elimina una instancia
 *   - onCreate: callback al crear una nueva instancia
 */

const logger = require('./logger.service');

function createRegistry({ name, keyFn, buildFn, destroyFn }) {
  const map = new Map();
  const pending = new Map();
  const revisions = new Map();
  const createListeners = new Set();

  function getRevision(key) {
    return revisions.get(key) || 0;
  }

  function bumpRevision(key) {
    const next = getRevision(key) + 1;
    revisions.set(key, next);
    return next;
  }

  async function getOrCreate(...args) {
    const k = keyFn(...args);
    if (map.has(k)) return map.get(k);
    if (pending.has(k)) return pending.get(k);

    const revision = getRevision(k);
    const buildPromise = (async () => {
      const instance = await buildFn(...args);

      // Si alguien hizo destroy/reload mientras se estaba construyendo,
      // descartamos esta instancia para evitar runtimes/listerners duplicados.
      if (getRevision(k) !== revision) {
        if (destroyFn) await Promise.resolve(destroyFn(instance));
        return map.get(k) || pending.get(k) || null;
      }

      map.set(k, instance);
      for (const listener of createListeners) {
        try { await listener(instance); }
        catch (err) { logger.error('registry_oncreate_error', { registry: name, error: err.message }); }
      }
      return instance;
    })().finally(() => {
      if (pending.get(k) === buildPromise) {
        pending.delete(k);
      }
    });

    pending.set(k, buildPromise);
    return buildPromise;
  }

  function get(...args) {
    const k = keyFn(...args);
    return map.get(k) || null;
  }

  function getAll() {
    return [...map.values()];
  }

  async function reload(...args) {
    const k = keyFn(...args);
    const current = map.get(k);
    bumpRevision(k);
    if (current && destroyFn) await Promise.resolve(destroyFn(current));
    map.delete(k);
    pending.delete(k);
    return getOrCreate(...args);
  }

  async function destroy(...args) {
    const k = keyFn(...args);
    const current = map.get(k);
    bumpRevision(k);
    if (current && destroyFn) await Promise.resolve(destroyFn(current));
    map.delete(k);
    pending.delete(k);
  }

  async function destroyByPrefix(prefix) {
    const destroyPromises = [];
    for (const [k, instance] of map.entries()) {
      if (k.startsWith(prefix)) {
        bumpRevision(k);
        if (destroyFn) destroyPromises.push(Promise.resolve(destroyFn(instance)));
        map.delete(k);
        pending.delete(k);
      }
    }

    for (const k of pending.keys()) {
      if (k.startsWith(prefix)) {
        bumpRevision(k);
        pending.delete(k);
      }
    }
    await Promise.all(destroyPromises);
  }

  function entries() {
    return map.entries();
  }

  function onCreate(listener) {
    createListeners.add(listener);
    return () => createListeners.delete(listener);
  }

  async function destroyAll() {
    const destroyPromises = [];
    for (const [k, instance] of map.entries()) {
      bumpRevision(k);
      if (destroyFn) destroyPromises.push(Promise.resolve(destroyFn(instance)));
      map.delete(k);
      pending.delete(k);
    }
    await Promise.all(destroyPromises);
  }

  return { getOrCreate, get, getAll, reload, destroy, destroyAll, destroyByPrefix, entries, onCreate };
}

module.exports = { createRegistry };
