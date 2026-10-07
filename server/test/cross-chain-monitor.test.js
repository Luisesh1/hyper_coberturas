const test = require('node:test');
const assert = require('node:assert/strict');

const { CrossChainMonitorService } = require('../src/services/cross-chain/cross-chain-monitor.service');

function step(overrides = {}) {
  return {
    planId: 1,
    order: 1,
    sourceNetwork: 'arbitrum',
    destinationNetwork: 'base',
    status: 'signed',
    provider: 'across',
    txHash: '0xtx',
    approvalTxHash: null,
    sentFees: { profile: 'low', maxFeePerGas: '1000', gasLimit: '300000' },
    realCostUsd: null,
    quote: {
      amountUsd: 345,
      deliveryToken: { address: '0xusdc', decimals: 6, priceUsd: 1 },
      quote: { toAmountRaw: '344830000', ref: {} },
    },
    ...overrides,
  };
}

function harness({ steps, observation = null, status = { status: 'pending' }, observeError = null }) {
  const updates = [];
  const recomputed = [];
  const observed = [];
  const monitor = new CrossChainMonitorService({
    repo: {
      listInFlightSteps: async () => steps,
      updateStep: async (planId, order, patch) => { updates.push({ planId, order, patch }); },
      recomputePlanStatus: async (planId) => { recomputed.push(planId); },
    },
    providers: { across: { id: 'across', status: async () => status }, lifi: { id: 'lifi', status: async () => status } },
    calibration: {
      observeReceipt: async (args) => {
        observed.push(args);
        if (observeError) throw observeError;
        return args.kind === 'approval' ? null : observation;
      },
    },
    getRpc: () => ({}),
    getPrices: async () => ({ ETH: '2000' }),
    logger: { warn() {}, error() {}, info() {} },
  });
  return { monitor, updates, recomputed, observed };
}

test('una tx firmada y minada pasa a source_confirmed con su gas real', async () => {
  const h = harness({
    steps: [step()],
    observation: { status: 'success', gasUsed: '200000', effectiveGasPriceWei: '500', l1FeeWei: '100000000' },
  });
  await h.monitor.tick();
  const { patch } = h.updates[0];
  assert.equal(patch.status, 'source_confirmed');
  // (200000 × 500 + 1e8) wei × 2000 USD/ETH
  assert.ok(Math.abs(patch.realCostUsd - ((200000 * 500 + 1e8) / 1e18) * 2000) < 1e-12);
  assert.equal(patch.walletOverrodeFees, false);
  assert.equal(h.observed[0].kind, 'bridge');
  assert.equal(h.observed[0].profile, 'low');
  assert.deepEqual(h.recomputed, [1]);
});

test('si la wallet pagó más que el tope enviado, se marca', async () => {
  const h = harness({ steps: [step()], observation: { status: 'success', gasUsed: '1', effectiveGasPriceWei: '5000', l1FeeWei: null } });
  await h.monitor.tick();
  assert.equal(h.updates[0].patch.walletOverrodeFees, true);
});

test('una tx revertida en origen deja el paso fallido', async () => {
  const h = harness({ steps: [step()], observation: { status: 'reverted', gasUsed: '1', effectiveGasPriceWei: '1' } });
  await h.monitor.tick();
  assert.equal(h.updates[0].patch.status, 'failed');
  assert.match(h.updates[0].patch.errorMessage, /revirtió/);
});

test('sin recibo todavía, no cambia nada', async () => {
  const h = harness({ steps: [step()], observation: null });
  await h.monitor.tick();
  assert.equal(h.updates.length, 0);
  assert.equal(h.recomputed.length, 0);
});

test('entregado: usa el monto del proveedor o el esperado y suma la pérdida del bridge', async () => {
  const h = harness({ steps: [step({ status: 'source_confirmed', realCostUsd: 0.05 })], status: { status: 'delivered', receivedRaw: null } });
  await h.monitor.tick();
  const { patch } = h.updates[0];
  assert.equal(patch.status, 'delivered');
  assert.equal(patch.receivedRaw, '344830000');
  assert.ok(Math.abs(patch.realCostUsd - (0.05 + 0.17)) < 1e-9);

  const h2 = harness({ steps: [step({ status: 'source_confirmed' })], status: { status: 'delivered', receivedRaw: '345000000' } });
  await h2.monitor.tick();
  assert.equal(h2.updates[0].patch.receivedRaw, '345000000');
});

test('reembolsado y fallido en el proveedor', async () => {
  const refunded = harness({ steps: [step({ status: 'source_confirmed' })], status: { status: 'refunded', message: null } });
  await refunded.monitor.tick();
  assert.equal(refunded.updates[0].patch.status, 'refunded');
  const failed = harness({ steps: [step({ status: 'source_confirmed' })], status: { status: 'failed', message: 'expiró' } });
  await failed.monitor.tick();
  assert.equal(failed.updates[0].patch.status, 'failed');
  assert.equal(failed.updates[0].patch.errorMessage, 'expiró');
});

test('un error en un paso no frena los demás', async () => {
  const steps = [step({ order: 1 }), step({ order: 2, status: 'source_confirmed' })];
  const h = harness({ steps, observeError: new Error('rpc caido'), status: { status: 'delivered', receivedRaw: '1' } });
  await h.monitor.tick();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].order, 2);
});

test('el approve confirmado también calibra el gas', async () => {
  const h = harness({ steps: [step({ approvalTxHash: '0xapp' })], observation: null });
  await h.monitor.tick();
  assert.ok(h.observed.some((o) => o.txHash === '0xapp' && o.kind === 'approval'));
});

test('tick no se solapa consigo mismo', async () => {
  let release;
  const h = harness({ steps: [] });
  h.monitor.repo.listInFlightSteps = () => new Promise((resolve) => { release = () => resolve([]); });
  const first = h.monitor.tick();
  await h.monitor.tick();
  release();
  await first;
});
