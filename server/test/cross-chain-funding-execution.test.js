const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createCrossChainFundingService } = require('../src/services/cross-chain/cross-chain-funding.service');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const ZERO = '0x0000000000000000000000000000000000000000';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPENDER = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A';
const ERC20 = new ethers.Interface(['function allowance(address,address) view returns (uint256)']);
const e18 = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

function snapshot({ native = false, amountUsd = 345 } = {}) {
  return {
    quote: { tx: { to: SPENDER, data: '0xold' }, approvalTxs: [] },
    txs: [{ kind: 'bridge', to: SPENDER, data: '0xold', value: '0' }],
    side: native ? 'token0' : 'token1',
    amountUsd,
    receivedUsd: amountUsd * 0.999,
    deliveryToken: native
      ? { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, priceUsd: 2000 }
      : { address: BASE_USDC, symbol: 'USDC', decimals: 6, isNative: false, priceUsd: 1 },
    costs: { expectedUsd: 0.2 },
    slippageBps: 50,
  };
}

function makePlan() {
  return {
    id: 1,
    userId: 7,
    walletAddress: WALLET,
    destinationNetwork: 'base',
    profile: 'low',
    status: 'executing',
    steps: [
      {
        order: 1, sourceNetwork: 'arbitrum', status: 'pending', provider: 'across',
        token: { address: ARB_USDC, symbol: 'USDC', decimals: 6, isNative: false },
        deliveryTokenAddress: BASE_USDC, amountRaw: '345000000', estCostUsd: 0.37, etaSec: 60,
        quote: snapshot(), txHash: null, nonce: null, sentFees: null, signedAt: null,
      },
      {
        order: 2, sourceNetwork: 'arbitrum', status: 'pending', provider: 'across',
        token: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true },
        deliveryTokenAddress: ZERO, amountRaw: e18(0.25).toString(), estCostUsd: 0.2, etaSec: 60,
        quote: snapshot({ native: true, amountUsd: 500 }), txHash: null, nonce: null, sentFees: null, signedAt: null,
      },
    ],
  };
}

function memoryRepo(plan) {
  return {
    plan,
    async getPlan(userId, id) { return userId === plan.userId && id === plan.id ? structuredClone(plan) : null; },
    async findActivePlan() { return plan.status === 'executing' ? structuredClone(plan) : null; },
    async updateStep(planId, order, patch) {
      const step = plan.steps.find((s) => s.order === order);
      Object.assign(step, patch);
      return structuredClone(step);
    },
    async updatePlan(planId, { status }) { if (status) plan.status = status; return structuredClone(plan); },
    async recomputePlanStatus() { return structuredClone(plan); },
  };
}

function fakeProvider(id, { costFactor = 0.999, fail = false, calls = [] } = {}) {
  return {
    id,
    calls,
    async quote(args) {
      calls.push(args);
      if (fail) throw Object.assign(new Error(`${id} caído`), { code: 'BRIDGE_QUOTE_FAILED' });
      const native = args.fromToken === ZERO;
      const toAmountRaw = native
        ? (BigInt(args.fromAmountRaw) * BigInt(Math.round(costFactor * 1e6))) / 1_000_000n
        : (BigInt(args.fromAmountRaw) * BigInt(Math.round(costFactor * 1e6))) / 1_000_000n;
      return {
        provider: id,
        fromNetwork: args.fromNetwork,
        toNetwork: args.toNetwork,
        fromToken: args.fromToken,
        toToken: args.toToken,
        fromAmountRaw: String(args.fromAmountRaw),
        toAmountRaw: toAmountRaw.toString(),
        toAmountMinRaw: toAmountRaw.toString(),
        feeCosts: [],
        approvalTxs: native ? [] : [{ to: args.fromToken, data: '0x095ea7b3', value: '0', spender: SPENDER }],
        tx: { to: SPENDER, data: `0xnew-${id}`, value: native ? String(args.fromAmountRaw) : '0', chainId: 42161, gasLimit: '250000' },
        etaSec: 30,
        ref: {},
      };
    },
  };
}

const oracle = {
  async getProfileFees({ profile }) {
    const map = { low: [100n, 0n], medium: [200n, 1n], high: [300n, 2n] };
    const [maxFee, prio] = map[profile];
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, expectedGasPriceWei: 50n, family: 'orbit' };
  },
  async estimateTxCosts({ txs }) {
    return {
      txs: txs.map((tx) => ({ kind: tx.kind, label: tx.label, gasLimit: '275000', expectedUsd: 0.01, maxUsd: 0.02 })),
      totalExpectedUsd: 0.01 * txs.length,
      totalMaxUsd: 0.02 * txs.length,
      totalMaxWei: (BigInt(txs.length) * e18(0.001)).toString(),
    };
  },
};

const BALANCE_OF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

function rpc({ balance = e18(0.3), allowance = 0n, tokenBalance = 10n ** 30n } = {}) {
  return {
    async getBalance() { return balance; },
    async call({ data }) {
      if (data.startsWith(BALANCE_OF.getFunction('balanceOf').selector)) {
        return BALANCE_OF.encodeFunctionResult('balanceOf', [tokenBalance]);
      }
      return ERC20.encodeFunctionResult('allowance', [allowance]);
    },
  };
}

function service({ plan = makePlan(), providers, rpcProvider = rpc(), clock = 1_000 } = {}) {
  const repo = memoryRepo(plan);
  const svc = createCrossChainFundingService({
    balances: {},
    feeOracle: oracle,
    planner: {},
    repo,
    providers: providers || { across: fakeProvider('across'), lifi: fakeProvider('lifi') },
    getPrices: async () => ({ ETH: '2000' }),
    getWrappedNativeToken: () => null,
    getProvider: () => rpcProvider,
    now: () => clock,
  });
  return { svc, repo, plan };
}

test('prepare de un ERC20: approve + bridge con las fees del perfil y la cotización nueva', async () => {
  const { svc, plan } = service();
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(result.requiresReconfirm, false);
  assert.deepEqual(result.txs.map((tx) => tx.kind), ['approval', 'bridge']);
  const bridge = result.txs[1];
  assert.equal(bridge.data, '0xnew-across');
  assert.equal(bridge.chainId, 42161);
  assert.equal(bridge.gas, '275000');
  assert.equal(bridge.maxFeePerGas, '100');
  assert.equal(bridge.maxPriorityFeePerGas, '0');
  assert.equal(plan.steps[0].quote.quote.tx.data, '0xnew-across', 'la cotización nueva queda guardada');
});

test('si la allowance ya alcanza, no se pide otro approve', async () => {
  const { svc } = service({ rpcProvider: rpc({ allowance: 10n ** 30n }) });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.deepEqual(result.txs.map((tx) => tx.kind), ['bridge']);
});

test('no se puede preparar el nativo antes que el ERC20 de la misma red', async () => {
  const { svc } = service();
  await assert.rejects(svc.prepareStep({ userId: 7, planId: 1, order: 2 }), (err) => err.code === 'STEP_OUT_OF_ORDER');
});

test('el nativo se recorta a saldo − reserva de los pasos pendientes de su red', async () => {
  const plan = makePlan();
  plan.steps[0].status = 'signed';
  // saldo 0,2 ETH (ya pagó el gas del ERC20); reserva = 1 tx × 0,001 ETH
  const { svc, plan: saved } = service({ plan, rpcProvider: rpc({ balance: e18(0.2) }) });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 2 });
  assert.equal(saved.steps[1].amountRaw, (e18(0.2) - e18(0.001)).toString());
  assert.equal(result.txs[0].value, (e18(0.2) - e18(0.001)).toString());
});

test('sin nativo por encima de la reserva se rechaza antes de firmar', async () => {
  const plan = makePlan();
  plan.steps[0].status = 'signed';
  const { svc } = service({ plan, rpcProvider: rpc({ balance: e18(0.0005) }) });
  await assert.rejects(svc.prepareStep({ userId: 7, planId: 1, order: 2 }), (err) => err.code === 'INSUFFICIENT_NATIVE_FOR_GAS');
});

test('pide reconfirmar si el costo subió más de un 20 %', async () => {
  const { svc } = service({ providers: { across: fakeProvider('across', { costFactor: 0.99 }) } });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  // 345 × 1 % = 3,45 USD + gas, contra 0,20 mostrados
  assert.equal(result.requiresReconfirm, true);
  assert.equal(result.previousCostUsd, 0.37);
  assert.ok(result.newCostUsd > 3);
});

test('si el proveedor del plan falla, recotiza con el otro', async () => {
  const { svc, plan } = service({ providers: { across: fakeProvider('across', { fail: true }), lifi: fakeProvider('lifi') } });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(result.txs.at(-1).data, '0xnew-lifi');
  assert.equal(plan.steps[0].provider, 'lifi');
});

test('un paso ya firmado no devuelve otra tx (doble clic o recarga)', async () => {
  const plan = makePlan();
  plan.steps[0].status = 'signed';
  plan.steps[0].txHash = '0xaaa';
  const { svc } = service({ plan });
  await assert.rejects(svc.prepareStep({ userId: 7, planId: 1, order: 1 }), (err) => err.code === 'STEP_ALREADY_SUBMITTED');
});

test('acelerar: misma tx y nonce, perfil siguiente y fees +12,5 % como mínimo', async () => {
  const plan = makePlan();
  Object.assign(plan.steps[0], {
    status: 'signed', txHash: '0xaaa', nonce: 12,
    sentFees: { profile: 'low', maxFeePerGas: '190', maxPriorityFeePerGas: '0', gasLimit: '275000' },
    quote: { ...snapshot(), txs: [{ kind: 'bridge', to: SPENDER, data: '0xsigned', value: '0' }] },
  });
  const { svc } = service({ plan });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1, speedUp: true });
  assert.equal(result.profile, 'medium');
  assert.equal(result.txs.length, 1);
  assert.equal(result.txs[0].data, '0xsigned');
  assert.equal(result.txs[0].nonce, 12);
  assert.equal(result.txs[0].maxFeePerGas, '214');
  assert.equal(result.txs[0].maxPriorityFeePerGas, '1');
  assert.equal(result.txs[0].replacement, true);
});

test('acelerar un paso que ya salió de origen no se permite', async () => {
  const plan = makePlan();
  Object.assign(plan.steps[0], { status: 'source_confirmed', txHash: '0xaaa', nonce: 1, sentFees: { profile: 'low', maxFeePerGas: '1', maxPriorityFeePerGas: '0' } });
  const { svc } = service({ plan });
  await assert.rejects(svc.prepareStep({ userId: 7, planId: 1, order: 1, speedUp: true }), (err) => err.code === 'STEP_NOT_REPLACEABLE');
});

test('submit del approve guarda solo su hash', async () => {
  const { svc, plan } = service();
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'approval', txHash: '0xapp' });
  assert.equal(plan.steps[0].approvalTxHash, '0xapp');
  assert.equal(plan.steps[0].status, 'pending');
});

test('submit del bridge firma el paso; repetir el mismo hash es idempotente; otro hash se rechaza', async () => {
  const { svc, plan } = service({ clock: 5_000 });
  const fees = { profile: 'low', maxFeePerGas: '100', maxPriorityFeePerGas: '0', gasLimit: '275000' };
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xb1', nonce: 4, fees });
  assert.equal(plan.steps[0].status, 'signed');
  assert.equal(plan.steps[0].nonce, 4);
  assert.equal(plan.steps[0].signedAt, 5_000);
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xb1', nonce: 4, fees });
  await assert.rejects(
    svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xb2', nonce: 5, fees }),
    (err) => err.code === 'STEP_ALREADY_SUBMITTED'
  );
  await svc.submitStep({
    userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xb3', nonce: 4, fees: { ...fees, replacement: true },
  });
  assert.equal(plan.steps[0].txHash, '0xb3');
});

test('saltar, seguir con lo que llegó y descartar', async () => {
  const { svc, plan } = service();
  await svc.skipStep({ userId: 7, planId: 1, order: 2 });
  assert.equal(plan.steps[1].status, 'skipped');

  const second = service();
  second.plan.steps[0].status = 'signed';
  await second.svc.continueWithArrived({ userId: 7, planId: 1 });
  assert.equal(second.plan.steps[1].status, 'skipped');
  assert.equal(second.plan.steps[0].status, 'signed', 'lo que está en vuelo se sigue vigilando');
  assert.equal(second.plan.status, 'partial');

  const third = service();
  await third.svc.discardPlan({ userId: 7, planId: 1 });
  assert.equal(third.plan.status, 'discarded');
});

test('no se salta un paso en vuelo', async () => {
  const plan = makePlan();
  plan.steps[0].status = 'signed';
  const { svc } = service({ plan });
  await assert.rejects(svc.skipStep({ userId: 7, planId: 1, order: 1 }), (err) => err.code === 'STEP_IN_FLIGHT');
});

test('la vista marca como lento un paso que tarda más del doble de lo previsto', async () => {
  const plan = makePlan();
  Object.assign(plan.steps[0], { status: 'source_confirmed', signedAt: 0, etaSec: 60 });
  const slow = service({ plan, clock: 181_000 });
  const view = await slow.svc.getPlanView({ userId: 7, planId: 1 });
  assert.equal(view.steps[0].isSlow, true);
  assert.equal(view.steps[1].isSlow, false);
  assert.ok(!JSON.stringify(view).includes('0xold'));
  const fresh = service({ plan: (() => { const p = makePlan(); Object.assign(p.steps[0], { status: 'signed', signedAt: 0, etaSec: 60 }); return p; })(), clock: 179_000 });
  assert.equal((await fresh.svc.getPlanView({ userId: 7, planId: 1 })).steps[0].isSlow, false);
});

test('un plan ajeno o inexistente es 404', async () => {
  const { svc } = service();
  await assert.rejects(svc.getPlanView({ userId: 99, planId: 1 }), (err) => err.code === 'PLAN_NOT_FOUND');
});


// ── Bugs hallados en la revisión del 2026-10-08 ─────────────────────────

test('la reconfirmación se mide contra el costo mostrado, no contra la última recotización', async () => {
  const plan = makePlan();
  plan.steps[0].quote = { ...plan.steps[0].quote, shownCostUsd: 0.37 };
  const { svc } = service({ plan, providers: { across: fakeProvider('across', { costFactor: 0.99 }) } });
  const first = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(first.requiresReconfirm, true);
  // El usuario dijo «Detener» y vuelve a intentar: el costo sigue siendo el doble del mostrado.
  const second = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(second.requiresReconfirm, true);
  assert.equal(second.previousCostUsd, 0.37);
});

test('sin shownCostUsd (planes viejos) la base es el costo estimado al crear el plan', async () => {
  const { svc, plan } = service({ providers: { across: fakeProvider('across', { costFactor: 0.99 }) } });
  await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(plan.steps[0].quote.shownCostUsd, 0.37);
});

test('una tx firmada se registra aunque el plan se haya descartado mientras se firmaba', async () => {
  const plan = makePlan();
  plan.status = 'discarded';
  const { svc } = service({ plan });
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xlate', nonce: 2, fees: null });
  assert.equal(plan.steps[0].status, 'signed');
  assert.equal(plan.steps[0].txHash, '0xlate');
});

test('una tx firmada se registra aunque «seguir con lo que llegó» haya saltado su paso', async () => {
  const plan = makePlan();
  plan.steps[0].status = 'skipped';
  plan.status = 'partial';
  const { svc } = service({ plan });
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xlate', nonce: 2, fees: null });
  assert.equal(plan.steps[0].status, 'signed');
});

test('si el saldo del ERC20 bajó desde el análisis, el monto se recorta al saldo', async () => {
  const { svc, plan } = service({ rpcProvider: rpc({ tokenBalance: 300_000_000n }) });
  const result = await svc.prepareStep({ userId: 7, planId: 1, order: 1 });
  assert.equal(result.amountRaw, '300000000');
  assert.equal(plan.steps[0].amountRaw, '300000000');
});

test('sin saldo del ERC20 se rechaza antes de firmar', async () => {
  const { svc } = service({ rpcProvider: rpc({ tokenBalance: 0n }) });
  await assert.rejects(svc.prepareStep({ userId: 7, planId: 1, order: 1 }), (err) => err.code === 'INSUFFICIENT_BALANCE');
});

test('acelerar guarda los hashes anteriores: el original aún puede ser el que entre', async () => {
  const plan = makePlan();
  Object.assign(plan.steps[0], { status: 'signed', txHash: '0xa1', nonce: 4, sentFees: { profile: 'low', maxFeePerGas: '100', maxPriorityFeePerGas: '0' } });
  const { svc } = service({ plan });
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xa2', nonce: 4, fees: { profile: 'medium', maxFeePerGas: '200', maxPriorityFeePerGas: '1', replacement: true } });
  await svc.submitStep({ userId: 7, planId: 1, order: 1, kind: 'bridge', txHash: '0xa3', nonce: 4, fees: { profile: 'high', maxFeePerGas: '300', maxPriorityFeePerGas: '2', replacement: true } });
  assert.equal(plan.steps[0].txHash, '0xa3');
  assert.deepEqual(plan.steps[0].sentFees.previousTxHashes, ['0xa1', '0xa2']);
});
