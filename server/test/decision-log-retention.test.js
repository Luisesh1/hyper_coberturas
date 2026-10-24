const test = require('node:test');
const assert = require('node:assert/strict');

const { pruneDecisionLog } = require('../src/services/protected-pool-maintenance.service');
const {
  createDecisionLogRetentionService,
} = require('../src/services/decision-log-retention.service');

// Executor falso: el SELECT count devuelve `candidates`; cada DELETE consume
// el siguiente rowCount de la lista (o `fallback` si se agota).
function fakeExecutor({ rowCounts = [], fallback = null, candidates = 1000 } = {}) {
  const deletes = [];
  let i = 0;
  return {
    deletes,
    async query(sql, params) {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ total: String(candidates) }] };
      deletes.push(params);
      const rowCount = i < rowCounts.length ? rowCounts[i] : fallback;
      i += 1;
      return { rowCount };
    },
  };
}

const baseCfg = {
  enabled: true,
  retentionDays: 30,
  intervalMs: 86_400_000,
  initialDelayMs: 600_000,
  batchSize: 5000,
  maxBatches: 200,
  pauseMs: 200,
};

function fakeLogger() {
  const calls = { info: [], warn: [] };
  return {
    calls,
    info: (m, meta) => calls.info.push([m, meta]),
    warn: (m, meta) => calls.warn.push([m, meta]),
    error: () => {},
  };
}

test('pruneDecisionLog se detiene en maxBatches y marca capped', async () => {
  const exec = fakeExecutor({ fallback: 5 });
  const r = await pruneDecisionLog(
    { dryRun: false, batchSize: 5, maxBatches: 3, pauseMs: 0 }, exec
  );
  assert.equal(exec.deletes.length, 3);
  assert.equal(r.deleted, 15);
  assert.equal(r.capped, true);
});

test('sin tope vacía hasta el último lote', async () => {
  const exec = fakeExecutor({ rowCounts: [5, 5, 2] });
  const r = await pruneDecisionLog({ dryRun: false, batchSize: 5 }, exec);
  assert.equal(exec.deletes.length, 3);
  assert.equal(r.deleted, 12);
  assert.equal(r.capped, false);
});

test('con tope pero el último lote queda corto, capped es false', async () => {
  const exec = fakeExecutor({ rowCounts: [5, 5, 2] });
  const r = await pruneDecisionLog({ dryRun: false, batchSize: 5, maxBatches: 3 }, exec);
  assert.equal(exec.deletes.length, 3);
  assert.equal(r.capped, false);
});

test('pauseMs espera entre lotes (no tras el último) con sleep inyectado', async () => {
  const exec = fakeExecutor({ rowCounts: [5, 5, 2] });
  const sleeps = [];
  await pruneDecisionLog(
    { dryRun: false, batchSize: 5, pauseMs: 50, sleep: async (ms) => sleeps.push(ms) }, exec
  );
  assert.deepEqual(sleeps, [50, 50]);
});

test('runOnce poda con la configuración y registra el resumen', async () => {
  const logger = fakeLogger();
  const calls = [];
  const prune = async (opts) => { calls.push(opts); return { deleted: 10, candidates: 10, capped: false }; };
  const svc = createDecisionLogRetentionService({ prune, config: baseCfg, logger });
  const summary = await svc.runOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, false);
  assert.equal(calls[0].retentionDays, 30);
  assert.equal(calls[0].maxBatches, 200);
  assert.equal(calls[0].batchSize, 5000);
  assert.equal(calls[0].pauseMs, 200);
  assert.equal(logger.calls.info[0][0], 'decision_log_pruned');
  assert.deepEqual(logger.calls.info[0][1], { deleted: 10, candidates: 10, capped: false });
  assert.equal(summary.deleted, 10);
});

test('runOnce no solapa ejecuciones', async () => {
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const prune = async () => { n += 1; await gate; return { deleted: 0, candidates: 0, capped: false }; };
  const svc = createDecisionLogRetentionService({ prune, config: baseCfg, logger: fakeLogger() });
  const a = svc.runOnce();
  const b = await svc.runOnce();
  assert.equal(b, null);
  release();
  await a;
  assert.equal(n, 1);
  await svc.runOnce();
  assert.equal(n, 2);
});

test('un fallo se registra y no lanza', async () => {
  const logger = fakeLogger();
  const prune = async () => { throw new Error('boom'); };
  const svc = createDecisionLogRetentionService({ prune, config: baseCfg, logger });
  assert.equal(await svc.runOnce(), null);
  assert.equal(logger.calls.warn[0][0], 'decision_log_prune_failed');
  assert.equal(logger.calls.warn[0][1].error, 'boom');
});

test('deshabilitado no programa nada', () => {
  let timers = 0;
  const svc = createDecisionLogRetentionService({
    prune: async () => ({}), config: { ...baseCfg, enabled: false }, logger: fakeLogger(),
    setTimer: () => { timers += 1; return {}; },
  });
  svc.start();
  assert.equal(timers, 0);
});

test('start programa el retraso inicial y luego el intervalo, ambos unref; stop limpia', async () => {
  const timers = [];
  const cleared = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
    timers.push(t);
    return t;
  };
  let runs = 0;
  const svc = createDecisionLogRetentionService({
    prune: async () => { runs += 1; return { deleted: 0, candidates: 0, capped: false }; },
    config: baseCfg, logger: fakeLogger(), setTimer, clearTimer: (t) => cleared.push(t),
  });
  svc.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 600_000);
  assert.equal(timers[0].unrefd, true);
  await timers[0].fn();
  assert.equal(runs, 1);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 86_400_000);
  assert.equal(timers[1].unrefd, true);
  svc.stop();
  assert.deepEqual(cleared, [timers[1]]); // solo queda pendiente el del intervalo
  // tras stop, un disparo tardío no reprograma
  await timers[1].fn();
  assert.equal(timers.length, 2);
});

test('stop antes del primer disparo limpia el retraso inicial', () => {
  const cleared = [];
  const t = { unref() {} };
  const svc = createDecisionLogRetentionService({
    prune: async () => ({}), config: baseCfg, logger: fakeLogger(),
    setTimer: () => t, clearTimer: (x) => cleared.push(x),
  });
  svc.start();
  svc.stop();
  assert.deepEqual(cleared, [t]);
});
