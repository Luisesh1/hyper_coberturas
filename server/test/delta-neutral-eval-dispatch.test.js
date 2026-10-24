const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
  deltaNeutralEvalKey,
} = require('../src/services/protected-pool-delta-neutral.service');

/**
 * El bucle de 2 s no puede quedarse esperando a una evaluacion completa (RPC
 * lenta): eso retrasa la deteccion de borde de todas las demas protecciones.
 * El chequeo ligero sigue en serie y las evaluaciones completas se despachan a
 * un limitador (tope global, en serie por `cuenta:activo`).
 */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeLogger() {
  const calls = { warn: [], error: [], info: [] };
  return {
    calls,
    warn: (event, meta) => calls.warn.push({ event, meta }),
    error: (event, meta) => calls.error.push({ event, meta }),
    info: (event, meta) => calls.info.push({ event, meta }),
    debug: () => {},
  };
}

function buildService(list, { maxConcurrentEvals = 2 } = {}) {
  const logger = makeLogger();
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: { listActiveDeltaNeutral: async () => list },
    logger,
    maxConcurrentEvals,
  });
  const started = [];
  const pending = [];
  service._tickProtection = async () => ({ marketContext: null, forceReason: null });
  service.evaluateProtection = (protection) => {
    started.push(protection.id);
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  return { service, logger, started, pending };
}

// Vacia la cola de microtareas sin depender de temporizadores reales.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('evaluateAll vuelve sin esperar a las evaluaciones', async () => {
  const list = [
    { id: 1, userId: 1, accountId: 1, inferredAsset: 'ETH' },
    { id: 2, userId: 1, accountId: 2, inferredAsset: 'ETH' },
    { id: 3, userId: 1, accountId: 3, inferredAsset: 'BTC' },
  ];
  const { service, started, pending } = buildService(list);

  await service.evaluateAll();

  assert.deepEqual(started, [1, 2], 'solo arrancan las que caben en el tope');
  assert.equal(service.running, false, 'el bucle ya termino su vuelta');

  pending[0].resolve();
  await flush();
  assert.deepEqual(started, [1, 2, 3], 'la tercera entra al liberarse un hueco');

  pending[1].resolve();
  pending[2].resolve();
  await service.drain();
  assert.equal(service.queuedEvals.size, 0);
});

test('misma cuenta y activo se evalúan en serie', async () => {
  const list = [
    { id: 1, userId: 1, accountId: 7, inferredAsset: 'ETH' },
    { id: 2, userId: 1, accountId: 7, inferredAsset: 'eth' },
  ];
  const { service, started, pending } = buildService(list);

  await service.evaluateAll();
  assert.deepEqual(started, [1]);

  pending[0].resolve();
  await flush();
  assert.deepEqual(started, [1, 2]);

  pending[1].resolve();
  await service.drain();
});

test('no encola duplicados mientras una evaluación sigue en curso', async () => {
  const list = [{ id: 1, userId: 1, accountId: 7, inferredAsset: 'ETH' }];
  const { service, started, pending } = buildService(list);

  await service.evaluateAll();
  await service.evaluateAll();
  await service.evaluateAll();
  assert.deepEqual(started, [1]);
  assert.equal(service.evalLimiter.size, 1);

  pending[0].resolve();
  await service.drain();
  assert.equal(service.queuedEvals.size, 0);
});

test('un fallo se registra y la siguiente vuelta reintenta', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const list = [{ id: 9, userId: 4, accountId: 7, inferredAsset: 'ETH' }];
  const { service, logger, started, pending } = buildService(list);

  await service.evaluateAll();
  pending[0].reject(new Error('rpc timeout'));
  await service.drain();
  await flush();

  const warn = logger.calls.warn.find((c) => c.event === 'protected_pool_delta_neutral_tick_failed');
  assert.ok(warn, 'el fallo se registra');
  assert.equal(warn.meta.protectionId, 9);
  assert.equal(warn.meta.userId, 4);
  assert.equal(warn.meta.error, 'rpc timeout');
  assert.equal(service.queuedEvals.size, 0);
  assert.deepEqual(unhandled, []);

  await service.evaluateAll();
  assert.deepEqual(started, [9, 9], 'la siguiente vuelta reintenta');
  pending[1].resolve();
  await service.drain();
});

test('un throw sincrono en evaluateProtection no deja la proteccion bloqueada', async () => {
  const list = [{ id: 5, userId: 1, accountId: 7, inferredAsset: 'ETH' }];
  const { service, logger } = buildService(list);
  let calls = 0;
  service.evaluateProtection = () => {
    calls += 1;
    throw new Error('boom');
  };

  await service.evaluateAll();
  await service.drain();
  await flush();
  assert.equal(service.queuedEvals.size, 0);
  assert.ok(logger.calls.warn.some((c) => c.event === 'protected_pool_delta_neutral_tick_failed'));

  await service.evaluateAll();
  await service.drain();
  assert.equal(calls, 2);
});

test('_tickProtection nulo no despacha nada y un fallo del tick se registra', async () => {
  const list = [
    { id: 1, userId: 1, accountId: 1, inferredAsset: 'ETH' },
    { id: 2, userId: 1, accountId: 2, inferredAsset: 'ETH' },
  ];
  const { service, logger, started, pending } = buildService(list);
  service._tickProtection = async (p) => {
    if (p.id === 1) throw new Error('tick roto');
    return null;
  };

  await service.evaluateAll();
  assert.deepEqual(started, []);
  assert.equal(pending.length, 0);
  assert.ok(logger.calls.warn.some((c) => c.event === 'protected_pool_delta_neutral_tick_failed'
    && c.meta.protectionId === 1));
});

test('drain respeta el timeout aunque una evaluacion no termine', async () => {
  const list = [{ id: 1, userId: 1, accountId: 1, inferredAsset: 'ETH' }];
  const { service } = buildService(list);
  await service.evaluateAll();
  // Diferido que nunca se resuelve: drain debe volver por el temporizador.
  await service.drain(1);
  assert.equal(service.queuedEvals.size, 1);
});

test('maxConcurrentEvals invalido cae a 3 en lugar de romper el arranque', () => {
  for (const bad of [0, -1, NaN, 1.5, '2']) {
    const service = new ProtectedPoolDeltaNeutralService({
      protectedPoolRepository: { listActiveDeltaNeutral: async () => [] },
      logger: makeLogger(),
      maxConcurrentEvals: bad,
    });
    assert.equal(service.maxConcurrentEvals, 3, `valor ${String(bad)}`);
  }
});

test('deltaNeutralEvalKey normaliza el activo', () => {
  assert.equal(deltaNeutralEvalKey({ accountId: 7, inferredAsset: 'eth' }), '7:ETH');
  assert.equal(deltaNeutralEvalKey({ accountId: 7 }), '7:UNKNOWN');
});
