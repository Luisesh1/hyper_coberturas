/**
 * Limitador de concurrencia por clave.
 * - Como mucho `maxConcurrent` tareas en curso en total.
 * - Como mucho una tarea en curso por clave.
 * - Orden FIFO. Una tarea que espera por su clave no ocupa un hueco global
 *   y no impide que arranquen tareas posteriores de otras claves.
 *
 * Usage:
 *   const limiter = new KeyedLimiter({ maxConcurrent: 3 });
 *   await limiter.run(`${accountId}:${asset}`, async () => { ... });
 */
class KeyedLimiter {
  constructor({ maxConcurrent } = {}) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('KeyedLimiter: maxConcurrent debe ser un entero >= 1');
    }
    this._max = maxConcurrent;
    this._queue = [];
    this._activeKeys = new Set();
    this._idleWaiters = [];
  }

  /** Tareas en cola más en curso. */
  get size() {
    return this._queue.length + this._activeKeys.size;
  }

  run(key, fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ key, fn, resolve, reject });
      this._pump();
    });
  }

  idle() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  _pump() {
    while (this._activeKeys.size < this._max) {
      const idx = this._queue.findIndex((t) => !this._activeKeys.has(t.key));
      if (idx === -1) break;
      const [task] = this._queue.splice(idx, 1);
      this._start(task);
    }
    if (this.size === 0 && this._idleWaiters.length) {
      const waiters = this._idleWaiters;
      this._idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  _start({ key, fn, resolve, reject }) {
    this._activeKeys.add(key);
    let result;
    try {
      result = Promise.resolve(fn());
    } catch (err) {
      result = Promise.reject(err);
    }
    // Se libera el hueco antes de resolver al llamador, así `size` ya es
    // coherente cuando su `await` continúa.
    const release = () => {
      this._activeKeys.delete(key);
      this._pump();
    };
    result.then(
      (value) => { release(); resolve(value); },
      (err) => { release(); reject(err); },
    );
  }
}

module.exports = KeyedLimiter;
