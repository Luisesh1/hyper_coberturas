/**
 * Integración contra Postgres real: solo corre con
 * CROSS_CHAIN_TEST_DATABASE_URL apuntando a una base desechable. Aplica la
 * migración 030 en un esquema temporal y lo borra al terminar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.CROSS_CHAIN_TEST_DATABASE_URL;
const skip = !DATABASE_URL && 'CROSS_CHAIN_TEST_DATABASE_URL no definido';

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

function step(order, overrides = {}) {
  return {
    order,
    sourceNetwork: 'arbitrum',
    token: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, isNative: false },
    deliveryToken: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    amountRaw: '345000000',
    provider: 'across',
    carriesDestinationGas: false,
    quoteSnapshot: { tx: { to: '0xbridge' }, amountUsd: 345 },
    costs: { expectedUsd: 0.15 },
    etaSec: 60,
    ...overrides,
  };
}

test('repositorio de planes contra Postgres', { skip }, async (t) => {
  const { Pool } = require('pg');
  const { createCrossChainPlanRepository } = require('../src/repositories/cross-chain-plan.repository');
  const schema = `cc_test_${process.pid}_${Date.now()}`;
  const pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);
  pool.on('connect', (client) => client.query(`SET search_path TO ${schema}`));
  // Las conexiones ya abiertas no pasaron por 'connect': se recrea el pool.
  await pool.end();
  const scoped = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/030_cross_chain_funding.sql'), 'utf8');
  await scoped.query(sql);

  const db = {
    query: (text, params) => scoped.query(text, params),
    async transaction(fn) {
      const client = await scoped.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
  let clock = 1000;
  const repo = createCrossChainPlanRepository({ db, now: () => clock });

  t.after(async () => {
    await scoped.query(`DROP SCHEMA ${schema} CASCADE`);
    await scoped.end();
  });

  const created = await repo.createPlan({
    userId: 7,
    walletAddress: WALLET,
    destinationNetwork: 'base',
    profile: 'low',
    thresholdPct: 3,
    request: { network: 'base' },
    analysis: { totals: { expectedUsd: 0.5 } },
    steps: [step(1), step(2, { token: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, isNative: true }, amountRaw: '200400000000000000' })],
  });

  await t.test('crea el plan con sus pasos pendientes', () => {
    assert.equal(created.status, 'executing');
    assert.equal(created.steps.length, 2);
    assert.equal(created.steps[0].status, 'pending');
    assert.equal(created.steps[1].token.isNative, true);
    assert.equal(created.steps[1].amountRaw, '200400000000000000');
    assert.equal(created.steps[0].estCostUsd, 0.15);
    assert.deepEqual(created.steps[0].quote, { tx: { to: '0xbridge' }, amountUsd: 345 });
    assert.equal(created.analysis.totals.expectedUsd, 0.5);
  });

  await t.test('solo un plan en curso por wallet (sin importar mayúsculas)', async () => {
    await assert.rejects(
      repo.createPlan({
        userId: 7, walletAddress: WALLET.toLowerCase(), destinationNetwork: 'base', profile: 'low',
        thresholdPct: 3, request: {}, analysis: {}, steps: [step(1)],
      }),
      (err) => err.code === 'ACTIVE_PLAN_EXISTS'
    );
  });

  await t.test('busca el plan activo y aísla por usuario', async () => {
    assert.equal((await repo.findActivePlan(7, WALLET.toUpperCase().replace('0X', '0x'))).id, created.id);
    assert.equal(await repo.getPlan(8, created.id), null);
    assert.equal((await repo.getPlan(7, created.id)).id, created.id);
  });

  await t.test('actualiza un paso y lo lista en vuelo', async () => {
    clock = 2000;
    const updated = await repo.updateStep(created.id, 1, {
      status: 'signed', txHash: '0xabc', nonce: 12, sentFees: { maxFeePerGas: '1' }, signedAt: 2000,
    });
    assert.equal(updated.status, 'signed');
    assert.equal(updated.nonce, 12);
    assert.deepEqual(updated.sentFees, { maxFeePerGas: '1' });
    assert.equal(updated.updatedAt, 2000);
    const inFlight = await repo.listInFlightSteps();
    assert.equal(inFlight.length, 1);
    assert.equal(inFlight[0].planId, created.id);
    assert.equal(inFlight[0].destinationNetwork, 'base');
    assert.equal(inFlight[0].profile, 'low');
  });

  await t.test('rechaza campos desconocidos', async () => {
    await assert.rejects(repo.updateStep(created.id, 1, { hack: 1 }), /Campo de paso desconocido/);
  });

  await t.test('el plan sigue en curso mientras haya pasos abiertos', async () => {
    await repo.updateStep(created.id, 1, { status: 'delivered', receivedRaw: '344890000' });
    const plan = await repo.recomputePlanStatus(created.id);
    assert.equal(plan.status, 'executing');
  });

  await t.test('cierra como partial si algo no llegó y como delivered si todo llegó', async () => {
    await repo.updateStep(created.id, 2, { status: 'skipped' });
    const plan = await repo.recomputePlanStatus(created.id);
    assert.equal(plan.status, 'partial');
    assert.ok(plan.finishedAt);
    assert.equal(await repo.findActivePlan(7, WALLET), null);

    const second = await repo.createPlan({
      userId: 7, walletAddress: WALLET, destinationNetwork: 'base', profile: 'medium',
      thresholdPct: 3, request: {}, analysis: {}, steps: [step(1)],
    });
    await repo.updateStep(second.id, 1, { status: 'delivered' });
    assert.equal((await repo.recomputePlanStatus(second.id)).status, 'delivered');
  });
});
