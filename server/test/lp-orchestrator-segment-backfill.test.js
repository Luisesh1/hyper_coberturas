/**
 * (a) Unitarios del constructor puro de tramos historicos.
 * (b) Integracion gated por SEGMENTS_TEST_DATABASE_URL: esquema temporal con
 *     una copia de las filas reales de public (solo lectura sobre public).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildHistoricalSegments,
  resolveHistoricalSegment,
} = require('../src/services/lp-orchestrator/segment-backfill');

const DEPLOY = 10_000;
const hist = (total = 20) => ({
  openedAt: 0,
  closedAt: DEPLOY,
  accounting: { totalNetPnlUsd: total },
});

function log() {
  return [
    { id: 1, kind: 'attach_lp', action: 'create-position', createdAt: 1000, txHashes: ['0xa'], payload: { protectedPoolId: 7 } },
    { id: 2, kind: 'decision', createdAt: 1500, accountingDelta: { lpFeesDelta: 1, priceDriftDelta: -0.5 } },
    {
      id: 3, kind: 'tx_finalized', action: 'modify-range', createdAt: 2000, txHashes: ['0xb'],
      accountingDelta: { gasCostUsd: 0.3, slippageCostUsd: 0.2, collectedFeesUsd: 0.4, capitalDeltaUsd: 0 },
    },
    { id: 4, kind: 'decision', createdAt: 2500, accountingDelta: { lpFeesDelta: 2, priceDriftDelta: 1 } },
    { id: 5, kind: 'tx_finalized', action: 'modify-range', createdAt: 3000, txHashes: ['0xc'], accountingDelta: { gasCostUsd: 0.1 } },
    { id: 6, kind: 'decision', createdAt: 3500, accountingDelta: { lpFeesDelta: 3, priceDriftDelta: 0 } },
    { id: 7, kind: 'kill_lp', action: 'close-to-usdc', createdAt: 4000 },
  ];
}

const sum = (segs) => segs.reduce((a, s) => a + s.accounting.totalNetPnlUsd, 0);

test('attach_lp, dos modify-range y kill_lp producen 3 tramos con los cortes exactos', () => {
  const { segments } = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: hist() });
  const real = segments.filter((s) => !s.label);
  assert.deepEqual(real.map((s) => [s.openedAt, s.closedAt]), [[1000, 2000], [2000, 3000], [3000, 4000]]);
  assert.deepEqual(real.map((s) => s.closeReason), ['manual_rerange', 'manual_rerange', 'lp_closed']);
  assert.ok(real.every((s) => s.accuracy === 'approximate' && s.openReason === 'backfill'));
  // Fees de decision + fees cobradas en el ajuste (tramo viejo); gas/slippage al tramo nuevo.
  assert.equal(real[0].accounting.lpFeesUsd, 1 + 0.4);
  assert.equal(real[0].accounting.gasSpentUsd, 0);
  assert.equal(real[1].accounting.gasSpentUsd, 0.3);
  assert.equal(real[1].accounting.swapSlippageUsd, 0.2);
  assert.equal(real[2].accounting.gasSpentUsd, 0.1);
});

test('suma de tramos + diferencia === total historico', () => {
  const h = hist(20);
  const { segments, differenceUsd } = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: h });
  assert.ok(Math.abs(sum(segments) - 20) < 1e-9);
  const diff = segments.find((s) => s.label);
  assert.equal(diff.closeReason, 'unknown');
  assert.equal(diff.accounting.priceDriftUsd, differenceUsd);
  assert.equal(diff.accounting.lpFeesUsd, 0);
  assert.equal(diff.closedAt, DEPLOY);
});

test('las filas posteriores al despliegue se ignoran', () => {
  const extra = [
    ...log(),
    { id: 8, kind: 'tx_finalized', action: 'modify-range', createdAt: DEPLOY, txHashes: ['0xd'] },
    { id: 9, kind: 'attach_lp', createdAt: DEPLOY + 5, txHashes: ['0xe'] },
    { id: 10, kind: 'decision', createdAt: DEPLOY + 6, accountingDelta: { lpFeesDelta: 99 } },
  ];
  const a = buildHistoricalSegments({ actionLog: extra, rebalances: [], historicalSegment: hist() });
  const b = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: hist() });
  assert.deepEqual(a, b);
});

test('un LP vivo al desplegar cierra en el despliegue y un finalize repetido no corta dos veces', () => {
  const rows = [
    { id: 1, kind: 'attach_lp', createdAt: 1000 },
    { id: 2, kind: 'tx_finalized', action: 'rebalance', createdAt: 2000, txHashes: ['0xb'] },
    { id: 3, kind: 'tx_finalized', action: 'rebalance', createdAt: 2100, txHashes: ['0xb'] },
  ];
  const { segments } = buildHistoricalSegments({ actionLog: rows, rebalances: [], historicalSegment: hist() });
  const real = segments.filter((s) => !s.label);
  assert.deepEqual(real.map((s) => [s.openedAt, s.closedAt, s.closeReason]), [
    [1000, 2000, 'manual_rerange'],
    [2000, DEPLOY, 'unknown'],
  ]);
});

test('kill redirigido a collect-fees no corta; sin eventos solo queda la diferencia', () => {
  const rows = [
    { id: 1, kind: 'attach_lp', createdAt: 1000 },
    { id: 2, kind: 'kill_lp', action: 'collect-fees', createdAt: 2000 },
  ];
  const { segments } = buildHistoricalSegments({ actionLog: rows, rebalances: [], historicalSegment: hist() });
  assert.equal(segments.filter((s) => !s.label).length, 1);
  const none = buildHistoricalSegments({ actionLog: [], rebalances: [], historicalSegment: hist(7) });
  assert.equal(none.segments.length, 1);
  assert.equal(none.differenceUsd, 7);
});

test('la cobertura de cada tramo usa solo los rebalanceos de su intervalo', () => {
  const rebalances = [
    { protectedPoolId: 7, createdAt: 1200, actualQtyAfter: 1, targetQtyAfter: 1 },
    { protectedPoolId: 7, createdAt: 2200, actualQtyAfter: 0.5, targetQtyAfter: 1 },
    { protectedPoolId: 8, createdAt: 2300, actualQtyAfter: 9, targetQtyAfter: 9 },
  ];
  const all = buildHistoricalSegments({ actionLog: log(), rebalances, historicalSegment: hist() });
  const segments = all.segments.filter((s) => !s.label);
  assert.equal(segments[0].coverage.adjustments, 1);
  assert.equal(segments[1].coverage.adjustments, 1);
  assert.equal(segments[2].coverage.adjustments, 0);
  // El pool del attach se hereda en los tramos siguientes.
  assert.deepEqual(segments.map((s) => s.protectedPoolId), [7, 7, 7]);
});

test('un nuevo attach cambia el pool y sin pool conocido la cobertura es null', () => {
  const rows = [
    { id: 1, kind: 'attach_lp', createdAt: 1000, payload: { protectedPoolId: 7 } },
    { id: 2, kind: 'kill_lp', action: 'close-to-usdc', createdAt: 2000 },
    { id: 3, kind: 'attach_lp', createdAt: 3000, payload: { protectedPoolId: 8 } },
    { id: 4, kind: 'tx_finalized', action: 'modify-range', createdAt: 4000, txHashes: ['0x1'] },
    { id: 5, kind: 'kill_lp', action: 'close-to-usdc', createdAt: 5000 },
    { id: 6, kind: 'attach_lp', createdAt: 6000, payload: { protectedPoolId: null } },
  ];
  const rebalances = [
    { protectedPoolId: 7, createdAt: 1500, actualQtyAfter: 1, targetQtyAfter: 1 },
    { protectedPoolId: 8, createdAt: 3500, actualQtyAfter: 1, targetQtyAfter: 1 },
    { protectedPoolId: 8, createdAt: 4500, actualQtyAfter: 1, targetQtyAfter: 1 },
  ];
  const real = buildHistoricalSegments({ actionLog: rows, rebalances, historicalSegment: hist() })
    .segments.filter((s) => !s.label);
  assert.deepEqual(real.map((s) => s.protectedPoolId), [7, 8, 8, null]);
  assert.deepEqual(real.map((s) => s.coverage && s.coverage.adjustments), [1, 1, 1, null]);
});

test('la fila de diferencia se marca backfill_diff y se suma al resolver el historico', () => {
  const first = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: hist(20) });
  const diff = first.segments.find((s) => s.label);
  assert.equal(diff.openReason, 'backfill_diff');
  assert.equal(diff.protectedPoolId, undefined);
  const resolved = resolveHistoricalSegment(first.segments.map((s) => ({ ...s, status: 'closed' })));
  assert.ok(Math.abs(resolved.accounting.totalNetPnlUsd - 20) < 1e-9);
});

test('aplicar dos veces da la misma salida (historico = suma de backfill)', () => {
  const first = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: hist(20.123456789123) });
  const stored = first.segments.map((s, i) => ({ ...s, status: 'closed', id: i }));
  const resolved = resolveHistoricalSegment(stored);
  assert.equal(resolved.closedAt, DEPLOY);
  const second = buildHistoricalSegments({ actionLog: log(), rebalances: [], historicalSegment: resolved });
  assert.deepEqual(second, first);
});

test('resolveHistoricalSegment prefiere el sembrado y devuelve null sin historico', () => {
  assert.equal(resolveHistoricalSegment([]), null);
  const seeded = { status: 'closed', accuracy: 'approximate', openReason: 'deploy', openedAt: 1, closedAt: 2, accounting: {} };
  assert.equal(resolveHistoricalSegment([seeded]), seeded);
});

const DATABASE_URL = process.env.SEGMENTS_TEST_DATABASE_URL;
const skip = !DATABASE_URL && 'SEGMENTS_TEST_DATABASE_URL no definido';

test('backfill sobre una copia de los datos reales', { skip }, async (t) => {
  const { Pool } = require('pg');
  const { runBackfill } = require('../src/scripts/backfill-orchestrator-segments');
  const segmentRepo = require('../src/repositories/lp-orchestrator-segment.repository');

  const schema = `seg_bf_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => {
    await scoped.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const dir = path.join(__dirname, '../src/db/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files.filter((n) => parseInt(n, 10) < 46)) {
    await scoped.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  // Copia (solo lectura de public) con FK padres, sin tocar nada fuera del esquema temporal.
  async function copy(table, where = '') {
    const { rows } = await admin.query(`SELECT * FROM public.${table} ${where}`);
    if (!rows.length) return 0;
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `"${c}"`).join(',');
    for (const row of rows) {
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      await scoped.query(`INSERT INTO ${table} (${colList}) VALUES (${ph})`, cols.map((c) => row[c]));
    }
    return rows.length;
  }
  // Solo importan lp_orchestrators/log/rebalanceos: se sueltan las FK del esquema
  // temporal para no arrastrar toda la cadena de padres (operaciones, etc.).
  const { rows: fks } = await scoped.query(
    `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
      WHERE contype = 'f' AND connamespace = $1::regnamespace`,
    [schema]
  );
  for (const fk of fks) await scoped.query(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.conname}"`);
  await copy('users');
  await copy('hyperliquid_accounts');
  await copy('protected_uniswap_pools');
  const nOrch = await copy('lp_orchestrators');
  await copy('lp_orchestrator_action_log');
  await copy('protected_pool_delta_rebalance_log');
  await scoped.query(fs.readFileSync(path.join(dir, files.find((n) => parseInt(n, 10) === 46)), 'utf8'));

  const snapshot = async () => {
    const out = {};
    const { rows } = await scoped.query('SELECT id FROM lp_orchestrators ORDER BY id');
    for (const { id } of rows) {
      out[id] = (await segmentRepo.listByOrchestrator(id, scoped)).map((s) => ({
        seq: s.seq, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt,
        closeReason: s.closeReason, net: s.accounting.totalNetPnlUsd, openReason: s.openReason,
      }));
    }
    return out;
  };

  const seededTotals = {};
  for (const { id, accounting_json: a } of (await scoped.query('SELECT id, accounting_json FROM lp_orchestrators')).rows) {
    seededTotals[id] = Number(JSON.parse(a || '{}').totalNetPnlUsd) || 0;
  }

  const dry = await runBackfill(scoped, { apply: false });
  assert.equal(dry.length, nOrch);
  const lines = [`real-data dry-run: ${dry.length} orquestadores`];
  for (const r of dry) {
    assert.ok(!r.skipped);
    const total = r.segments.reduce((a, s) => a + s.accounting.totalNetPnlUsd, 0);
    assert.ok(Math.abs(total - seededTotals[r.orchestratorId]) < 1e-6,
      `orquestador ${r.orchestratorId}: suma ${total} != ${seededTotals[r.orchestratorId]}`);
    lines.push(`  id=${r.orchestratorId} tramos=${r.segments.length} differenceUsd=${r.differenceUsd.toFixed(4)} total=${seededTotals[r.orchestratorId].toFixed(4)}`);
  }
  console.log(lines.join('\n'));

  // Dry-run no escribe.
  const before = await snapshot();
  await runBackfill(scoped, { apply: false });
  assert.deepEqual(await snapshot(), before);

  await runBackfill(scoped, { apply: true });
  const once = await snapshot();
  for (const r of dry) {
    const stored = (await segmentRepo.listByOrchestrator(r.orchestratorId, scoped))
      .filter((s) => s.openReason === 'backfill_diff');
    assert.equal(stored.length, 1, `orquestador ${r.orchestratorId}: una fila de diferencia`);
    assert.equal(stored[0].status, 'closed');
    assert.equal(stored[0].accuracy, 'approximate');
  }
  const second = await runBackfill(scoped, { apply: true });
  assert.deepEqual(await snapshot(), once);
  for (const r of second) {
    const rows = once[r.orchestratorId].filter((s) => s.status === 'closed');
    assert.ok(Math.abs(rows.reduce((a, s) => a + s.net, 0) - seededTotals[r.orchestratorId]) < 1e-6);
  }
});
