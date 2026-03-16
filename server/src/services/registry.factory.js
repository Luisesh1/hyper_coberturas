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

function createRegistry({ name, keyFn, buildFn, destroyFn }) {
  const map = new Map();
  const createListeners = new Set();

  async function getOrCreate(...args) {
    const k = keyFn(...args);
    if (map.has(k)) return map.get(k);
    return _build(k, args);
  }

  async function _build(k, args) {
    const instance = await buildFn(...args);
    map.set(k, instance);
    for (const listener of createListeners) {
      try { await listener(instance); }
      catch (err) { console.error(`[${name}] Error en onCreate:`, err.message); }
    }
    return instance;
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
    if (current && destroyFn) destroyFn(current);
    map.delete(k);
    return _build(k, args);
  }

  function destroy(...args) {
    const k = keyFn(...args);
    const current = map.get(k);
    if (current && destroyFn) destroyFn(current);
    map.delete(k);
  }

  function destroyByPrefix(prefix) {
    for (const [k, instance] of map.entries()) {
      if (k.startsWith(prefix)) {
        if (destroyFn) destroyFn(instance);
        map.delete(k);
      }
    }
  }

  function entries() {
    return map.entries();
  }

  function onCreate(listener) {
    createListeners.add(listener);
    return () => createListeners.delete(listener);
  }

  return { getOrCreate, get, getAll, reload, destroy, destroyByPrefix, entries, onCreate };
}

module.exports = { createRegistry };
