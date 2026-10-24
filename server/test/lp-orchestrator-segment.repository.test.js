/**
 * (a) mapRow: unitario.
 * (b) Integracion contra Postgres real, solo con SEGMENTS_TEST_DATABASE_URL:
 *     aplica TODAS las migraciones en un esquema temporal (nunca toca public)
 *     y lo borra al terminar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const segmentRepoModule = require('../src/repositories/lp-orchestrator-segment.repository');
const orchestratorRepoModule = require('../src/repositories/lp-orchestrator.repository');

const DATABASE_URL = process.env.SEGMENTS_TEST_DATABASE_URL;
const skip = !DATABASE_URL && 'SEGMENTS_TEST_DATABASE_URL no definido';

test('mapRow del tramo convierte JSON y numericos', () => {
  const seg = segmentRepoModule.mapRow({
    id: '7', orchestrator_id: '3', seq: '2', status: 'open', accuracy: 'exact',
    position_identifier: '123', pool_address: '0xabc', protected_pool_id: '9', policy_version: null,
    opened_at: '1000', open_price: '2500.5', range_lower_price: '2400', range_upper_price: '2600',
    open_value_usd: '100', open_amount0: '0.02', open_amount1: '50', open_reason: 'rerange',
    open_tx_hashes_json: '["0x1"]', closing_started_at: null, closed_at: null,
    close_price: null, close_value_usd: null, close_reason: null, close_tx_hashes_json: null,
    accounting_json: '{"lpFeesUsd":5}', baseline_accounting_json: '{"lpFeesUsd":1}',
    hedge_baseline_json: null, shadow_baselines_json: '{"a":1}', lp_baseline_snapshot_json: null,
    hedge_open_qty: '0.5', hedge_close_qty: null, coverage_json: null,
    created_at: '1000', updated_at: '1001',
  });
  assert.equal(seg.id, 7);
  assert.equal(seg.protectedPoolId, 9);
  assert.equal(seg.openPrice, 2500.5);
  assert.deepEqual(seg.openTxHashes, ['0x1']);
  assert.deepEqual(seg.accounting, { lpFeesUsd: 5 });
  assert.deepEqual(seg.baselineAccounting, { lpFeesUsd: 1 });
  assert.deepEqual(seg.shadowBaselines, { a: 1 });
  assert.equal(seg.hedgeOpenQty, 0.5);
  assert.equal(seg.closedAt, null);
  assert.equal(segmentRepoModule.mapRow(null), null);
});

test('mapRow del orquestador expone activeSegmentId', () => {
  const base = {
    id: 1, user_id: 1, initial_total_usd: '10', created_at: '1', updated_at: '1',
  };
  assert.equal(orchestratorRepoModule.mapRow({ ...base, active_segment_id: '4' }).activeSegmentId, 4);
  assert.equal(orchestratorRepoModule.mapRow(base).activeSegmentId, null);
});

test('repositorio de tramos contra Postgres', { skip }, async (t) => {
  const { Pool } = require('pg');
  const schema = `seg_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const scoped = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => {
    await scoped.query(`DROP SCHEMA ${schema} CASCADE`);
    await scoped.end();
  });

  const dir = path.join(__dirname, '../src/db/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const before046 = files.filter((f) => parseInt(f, 10) < 46);
  for (const f of before046) await scoped.query(fs.readFileSync(path.join(dir, f), 'utf8'));

  const { rows: [user] } = await scoped.query(
    `INSERT INTO users (username, password_hash, name, created_at, updated_at)
     VALUES ('seg_t', 'x', 'seg', 1, 1) RETURNING id`
  );
  const { rows: [account] } = await scoped.query(
    `INSERT INTO hyperliquid_accounts (user_id, alias, address, created_at, updated_at)
     VALUES ($1, 'a', '0xacc', 1, 1) RETURNING id`,
    [user.id]
  );
  async function insertPool(position) {
    const { rows } = await scoped.query(
      `INSERT INTO protected_uniswap_pools (user_id, hyperliquid_account_id, network, version,
         wallet_address, position_identifier, token0_symbol, token1_symbol, range_lower_price,
         range_upper_price, inferred_asset, hedge_size, hedge_notional_usd,
         configured_hedge_notional_usd, leverage, pool_snapshot_json, created_at, updated_at)
       VALUES ($1,$2,'arbitrum','v3','0xw',$3,'A','B',1,2,'ETH',1,1,1,1,'{}',1,1)
       RETURNING id`,
      [user.id, account.id, position]
    );
    return rows[0].id;
  }
  const hedgedPoolId = await insertPool('tokH');
  const orphanPoolId = await insertPool('tokO');

  async function insertOrch({ status, position, accounting, pool = null, evaluation = null, protectedPoolId = null }) {
    const { rows } = await scoped.query(
      `INSERT INTO lp_orchestrators (user_id, name, network, version, wallet_address,
         token0_address, token1_address, token0_symbol, token1_symbol, status,
         active_position_identifier, active_pool_address, initial_total_usd,
         strategy_config_json, accounting_json, last_evaluation_json, created_at, updated_at,
         active_protected_pool_id)
       VALUES ($1,'o','arbitrum','v3','0xw','0xa','0xb','A','B',$2,$3,$4,100,'{}',$5,$6,1000,1000,$7)
       RETURNING id`,
      [user.id, status, position, pool, JSON.stringify(accounting), evaluation && JSON.stringify(evaluation), protectedPoolId]
    );
    return rows[0].id;
  }
  const activeId = await insertOrch({
    status: 'active', position: 'tok1', pool: '0xpool', accounting: { lpFeesUsd: 5 },
    evaluation: { poolSnapshot: { rangeLowerPrice: 2400, rangeUpperPrice: 2600 } },
  });
  const hedgedId = await insertOrch({
    status: 'active', position: 'tokH', pool: '0xpool', accounting: {}, protectedPoolId: hedgedPoolId,
  });
  const badJsonId = await insertOrch({
    status: 'active', position: 'tokBad', pool: '0xpool', accounting: {}, evaluation: null,
  });
  await scoped.query(`UPDATE lp_orchestrators SET last_evaluation_json = 'not json' WHERE id = $1`, [badJsonId]);
  const badNumId = await insertOrch({
    status: 'active', position: 'tokNum', pool: '0xpool', accounting: {},
    evaluation: { poolSnapshot: { rangeLowerPrice: 'abc', rangeUpperPrice: 5 } },
  });
  const emptyJsonId = await insertOrch({
    status: 'active', position: 'tokEmpty', pool: '0xpool', accounting: {}, evaluation: null,
  });
  await scoped.query(`UPDATE lp_orchestrators SET last_evaluation_json = '' WHERE id = $1`, [emptyJsonId]);
  const stoppedId = await insertOrch({ status: 'stopped', position: null, accounting: { lpFeesUsd: 2 } });

  await scoped.query(fs.readFileSync(path.join(dir, files.find((f) => parseInt(f, 10) === 46)), 'utf8'));

  const db = {
    query: (text, params) => scoped.query(text, params),
  };
  // El repo usa `db` global por defecto; todo se pasa con executor explicito.
  const repo = segmentRepoModule;
  const orchRepo = orchestratorRepoModule;

  await t.test('la siembra crea 2 tramos y conserva el total', async () => {
    const segs = await repo.listByOrchestrator(activeId, db);
    assert.equal(segs.length, 2);
    const [live, hist] = segs;
    assert.equal(hist.seq, 1);
    assert.equal(hist.status, 'closed');
    assert.equal(hist.accuracy, 'approximate');
    assert.equal(hist.closeReason, 'unknown');
    assert.equal(hist.accounting.lpFeesUsd, 5);
    assert.deepEqual(hist.baselineAccounting, {});
    assert.equal(live.seq, 2);
    assert.equal(live.status, 'open');
    assert.equal(live.baselineAccounting.lpFeesUsd, 5);
    assert.equal(live.positionIdentifier, 'tok1');
    assert.equal(live.rangeLowerPrice, 2400);
    assert.equal(live.rangeUpperPrice, 2600);
    const { rows } = await scoped.query('SELECT active_segment_id, accounting_json FROM lp_orchestrators WHERE id=$1', [activeId]);
    assert.equal(rows[0].active_segment_id, live.id);
    assert.equal(JSON.parse(rows[0].accounting_json).lpFeesUsd, 5);

    const stopped = await repo.listByOrchestrator(stoppedId, db);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].accounting.lpFeesUsd, 2);
    assert.equal((await repo.getActive(stoppedId, db)), null);
    const o = await scoped.query('SELECT active_segment_id FROM lp_orchestrators WHERE id=$1', [stoppedId]);
    assert.equal(o.rows[0].active_segment_id, null);
  });

  await t.test('JSON invalido o no numerico en last_evaluation_json deja el rango en NULL', async () => {
    for (const id of [badJsonId, emptyJsonId]) {
      const live = await repo.getActive(id, db);
      assert.ok(live, 'tramo vivo sembrado');
      assert.equal(live.rangeLowerPrice, null);
      assert.equal(live.rangeUpperPrice, null);
    }
    const num = await repo.getActive(badNumId, db);
    assert.equal(num.rangeLowerPrice, null);
    assert.equal(num.rangeUpperPrice, 5);
  });

  await t.test('un segundo tramo vivo viola el indice parcial', async () => {
    await assert.rejects(
      repo.create({ orchestratorId: activeId, baselineAccounting: {} }, db),
      (err) => err.code === '23505'
    );
  });

  await t.test('markClosing -> reopen -> close respeta transiciones', async () => {
    const live = await repo.getActive(activeId, db);
    assert.equal(await repo.reopen(live.id, db), null);
    assert.equal(await repo.markClosing(live.id, { at: 5 }, db), live.id);
    assert.equal(await repo.markClosing(live.id, { at: 6 }, db), null);
    assert.equal((await repo.getActive(activeId, db)).status, 'closing');
    assert.equal(await repo.reopen(live.id, db), live.id);
    assert.equal((await repo.getById(activeId, live.id, db)).closingStartedAt, null);
    assert.equal(await repo.markClosing(live.id, { at: 7 }, db), live.id);
    const closedId = await repo.close(live.id, {
      closedAt: 9, closePrice: 2500, closeValueUsd: 99, closeReason: 'manual_rerange',
      closeTxHashes: ['0xt'], accounting: { lpFeesUsd: 3 }, hedgeCloseQty: 0.4,
      coverage: { avgPct: 90 },
    }, db);
    assert.equal(closedId, live.id);
    assert.equal(await repo.close(live.id, { closeReason: 'unknown' }, db), null);
    assert.equal(await repo.markClosing(live.id, {}, db), null);
    const closed = await repo.getById(activeId, live.id, db);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closeReason, 'manual_rerange');
    assert.deepEqual(closed.closeTxHashes, ['0xt']);
    assert.equal(closed.accounting.lpFeesUsd, 3);
    assert.deepEqual(closed.coverage, { avgPct: 90 });
    assert.equal(await repo.getActive(activeId, db), null);
  });

  await t.test('create asigna seq = max+1 y el segmento queda enlazable', async () => {
    const seg = await repo.create({
      orchestratorId: activeId, positionIdentifier: 'tok2', poolAddress: '0xpool',
      protectedPoolId: null, openedAt: 20, openPrice: 2500, rangeLowerPrice: 2450,
      rangeUpperPrice: 2550, openValueUsd: 100, openReason: 'rerange', openTxHashes: ['0xo'],
      baselineAccounting: { lpFeesUsd: 5 }, hedgeBaseline: { a: 1 }, hedgeOpenQty: 0.3,
    }, db);
    assert.equal(seg.seq, 3);
    assert.equal(seg.status, 'open');
    assert.equal(seg.accuracy, 'exact');
    assert.deepEqual(seg.hedgeBaseline, { a: 1 });
    assert.equal(await orchRepo.updateActiveSegment(await userIdOf(activeId), activeId, seg.id, db), activeId);
    const { rows } = await scoped.query('SELECT active_segment_id FROM lp_orchestrators WHERE id=$1', [activeId]);
    assert.equal(rows[0].active_segment_id, seg.id);

    const logId = await orchRepo.appendActionLog({
      orchestratorId: activeId, kind: 'decision', segmentId: seg.id,
    }, db);
    const { rows: lr } = await scoped.query('SELECT segment_id FROM lp_orchestrator_action_log WHERE id=$1', [logId]);
    assert.equal(lr[0].segment_id, seg.id);
  });

  async function userIdOf(orchId) {
    const { rows } = await scoped.query('SELECT user_id FROM lp_orchestrators WHERE id=$1', [orchId]);
    return rows[0].user_id;
  }

  await t.test('replaceHistorical sustituye el sembrado, no toca el vivo y renumera', async () => {
    const before = await repo.listByOrchestrator(activeId, db);
    const live = before.find((s) => s.status === 'open');
    // El sembrado vivo, ya cerrado en un test previo, es exacto con open_reason 'deploy':
    // no es historico reconstruido y debe sobrevivir.
    const exactDeploy = before.filter((s) => s.status === 'closed' && s.accuracy === 'exact' && s.openReason === 'deploy');
    assert.equal(exactDeploy.length, 1);
    await repo.replaceHistorical(activeId, [
      { openedAt: 10, closedAt: 15, openReason: 'backfill', closeReason: 'manual_rerange', accounting: { lpFeesUsd: 1 }, baselineAccounting: {} },
      { openedAt: 15, closedAt: 20, openReason: 'backfill', closeReason: 'unknown', accounting: { lpFeesUsd: 2 }, baselineAccounting: {} },
    ], db);
    const after = (await repo.listByOrchestrator(activeId, db)).reverse();
    // El historico sembrado (approximate/deploy) se sustituye; el vivo se conserva.
    assert.deepEqual(after.map((s) => s.seq), after.map((_, i) => i + 1));
    assert.ok(after.some((s) => s.id === live.id));
    assert.equal(after.filter((s) => s.openReason === 'backfill').length, 2);
    assert.equal(after.filter((s) => s.openReason === 'deploy' && s.accuracy === 'approximate').length, 0);
    assert.ok(after.some((s) => s.id === exactDeploy[0].id && s.status === 'closed'));
    const times = after.map((s) => s.openedAt);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.equal(after.find((s) => s.id === live.id).status, 'open');
  });

  await t.test('delta rebalance log resuelve segment_id del orquestador activo', async () => {
    const deltaRepo = require('../src/repositories/protected-pool-delta-rebalance.repository');
    const hedgedSeg = await repo.getActive(hedgedId, db);
    assert.equal(hedgedSeg.protectedPoolId, hedgedPoolId);
    const read = async (id) => (await scoped.query(
      'SELECT segment_id FROM protected_pool_delta_rebalance_log WHERE id=$1', [id]
    )).rows[0].segment_id;
    const base = { reason: 'drift', executionMode: 'market' };

    const resolved = await deltaRepo.create({ ...base, protectedPoolId: hedgedPoolId }, db);
    assert.equal(await read(resolved), hedgedSeg.id);

    const explicit = await deltaRepo.create({ ...base, protectedPoolId: hedgedPoolId, segmentId: 999 }, db);
    assert.equal(await read(explicit), 999);

    const none = await deltaRepo.create({ ...base, protectedPoolId: orphanPoolId }, db);
    assert.equal(await read(none), null);
  });
});
