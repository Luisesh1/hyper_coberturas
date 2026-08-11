// Tiempo máximo (ms) que esperamos a que las requests HTTP en vuelo
// terminen ANTES de cerrar el pool DB y forzar salida. 15s es suficiente
// para flows largos (attach-lp, finalize, prepare) sin demorar
// indefinidamente reinicios.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;
// Intervalo de polling del contador de requests in-flight durante el drain.
const SHUTDOWN_DRAIN_POLL_MS = 100;

function createRequestTracker() {
  let count = 0;
  return {
    track(_req, res) {
      count += 1;
      let completed = false;
      const done = () => {
        if (completed) return;
        completed = true;
        count = Math.max(0, count - 1);
      };
      res.once('finish', done);
      res.once('close', done);
    },
    inFlight() {
      return count;
    },
  };
}

function startHttpServer({ server, port, onShutdown }) {
  // Contador de requests HTTP actualmente en proceso. Se incrementa al
  // recibir 'request' y se decrementa cuando la response termina (close
  // o finish). Sirve para que el shutdown espere a que llegue a 0 antes
  // de cerrar el pool DB.
  const requestTracker = createRequestTracker();
  server.on('request', requestTracker.track);

  return new Promise((resolve, reject) => {
    let shuttingDown = false;

    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve(server);
    });

    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;

      // 1. Dejar de aceptar nuevas conexiones HTTP. Las existentes siguen.
      //    `server.close()` no termina hasta que todas las conexiones
      //    keep-alive se cierran, así que NO lo awaitamos — solo lo
      //    invocamos para que el listener pare.
      server.close();

      // 2. Esperar a que todas las requests in-flight terminen (con un
      //    timeout duro). Esto previene el bug de "Cannot use a pool
      //    after calling end on the pool" cuando un request a medio
      //    procesar tenía pendiente una query DB y el shutdown cerró
      //    el pool.
      const drainStartedAt = Date.now();
      while (requestTracker.inFlight() > 0) {
        if (Date.now() - drainStartedAt >= SHUTDOWN_DRAIN_TIMEOUT_MS) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_POLL_MS));
      }

      if (typeof onShutdown === 'function') {
        await Promise.resolve(onShutdown());
      }
      process.exit(0);
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

module.exports = { createRequestTracker, startHttpServer };
