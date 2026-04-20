/**
 * Lightweight per-key mutex for serializing async operations.
 * No external dependencies - uses promise chaining.
 *
 * Usage:
 *   const mutex = new KeyedMutex();
 *   await mutex.runExclusive(hedgeId, async () => { ... });
 */
class KeyedMutex {
  constructor() {
    this._locks = new Map();
  }

  async runExclusive(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    let releaseFn;
    const next = new Promise((resolve) => { releaseFn = resolve; });
    this._locks.set(key, next);

    await prev;
    try {
      return await fn();
    } finally {
      // Solo borrar si nuestra promesa sigue siendo la última; si otra
      // llamada se encoló después, ella se encargará de limpiarlo.
      // Sin este guard, A borra la entrada cuando B ya había reemplazado
      // el valor, y una C posterior cree que no hay lock y entra en paralelo.
      if (this._locks.get(key) === next) {
        this._locks.delete(key);
      }
      releaseFn();
    }
  }
}

module.exports = KeyedMutex;
