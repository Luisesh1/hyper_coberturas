const test = require('node:test');
const assert = require('node:assert/strict');

const { createCrossChainFundingService } = require('../src/services/cross-chain/cross-chain-funding.service');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const ZERO = '0x0000000000000000000000000000000000000000';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const e18 = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

function balances({ baseNative = '0', baseUsdc = 180, arbStatus = 'ok' } = {}) {
  return {
    totalUsd: 1000,
    networks: [
      {
        network: 'base', label: 'Base', chainId: 8453, nativeSymbol: 'ETH', status: 'ok', nativeBalanceRaw: baseNative,
        assets: [
          { id: 'native', address: null, symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: baseNative, usdPrice: 2000, usdValue: Number(BigInt(baseNative)) / 1e18 * 2000 },
          { id: BASE_USDC.toLowerCase(), address: BASE_USDC, symbol: 'USDC', decimals: 6, isNative: false, balanceRaw: String(baseUsdc * 1e6), usdPrice: 1, usdValue: baseUsdc },
        ],
      },
      {
        network: 'arbitrum', label: 'Arbitrum One', chainId: 42161, nativeSymbol: 'ETH', status: arbStatus, error: arbStatus === 'error' ? 'rpc caido' : undefined,
        nativeBalanceRaw: e18(0.3),
        assets: arbStatus === 'error' ? [] : [
          { id: 'native', address: null, symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: e18(0.3), usdPrice: 2000, usdValue: 600 },
          { id: ARB_USDC.toLowerCase(), address: ARB_USDC, symbol: 'USDC', decimals: 6, isNative: false, balanceRaw: '420000000', usdPrice: 1, usdValue: 420 },
        ],
      },
    ],
  };
}

const LP_COST = { low: 0.09, medium: 0.12, high: 0.16 };
function fakeOracle() {
  const calls = [];
  return {
    calls,
    async estimateTxCosts({ network, profile, txs }) {
      calls.push({ network, profile, kinds: txs.map((tx) => tx.kind) });
      const per = network === 'base' ? LP_COST[profile] / txs.length : 0.01;
      return {
        txs: txs.map((tx) => ({ kind: tx.kind, label: tx.label, expectedUsd: per, maxUsd: per * 2 })),
        totalExpectedUsd: per * txs.length,
        totalMaxUsd: per * txs.length * 2,
        totalMaxWei: e18(0.0005),
        profilesMatter: true,
      };
    },
  };
}

function fakePlanner() {
  const calls = [];
  return {
    calls,
    async buildBridgePlan(args) {
      calls.push(args);
      return {
        steps: [{
          order: 1, sourceId: 'arbitrum:' + ARB_USDC.toLowerCase(), sourceNetwork: 'arbitrum',
          token: { address: ARB_USDC, symbol: 'USDC', decimals: 6, isNative: false },
          amountRaw: '345000000', amountUsd: 345, side: 'token1',
          deliveryToken: { address: BASE_USDC, symbol: 'USDC', decimals: 6, isNative: false, priceUsd: 1 },
          provider: 'across', quote: { tx: { to: '0xbridge', data: '0xsecret' }, approvalTxs: [] }, txs: [{ kind: 'bridge', data: '0xsecret' }],
          receivedRaw: '344830000', receivedUsd: 344.83, carriesDestinationGas: true, forced: false, etaSec: 60,
          alternative: { provider: 'lifi', costUsd: 0.98 },
          costs: { gasOrigin: { expectedUsd: 0.04, maxUsd: 0.08, l1Usd: 0, profilesMatter: false, txs: [] }, bridgeFees: [], bridgeCostUsd: 0.17, expectedUsd: 0.21, maxUsd: 0.25, costPct: 0.06 },
          costsByProfile: {
            low: { gasOriginExpectedUsd: 0.04, gasOriginMaxUsd: 0.08, expectedUsd: 0.21, maxUsd: 0.25 },
            medium: { gasOriginExpectedUsd: 0.05, gasOriginMaxUsd: 0.1, expectedUsd: 0.22, maxUsd: 0.27 },
            high: { gasOriginExpectedUsd: 0.06, gasOriginMaxUsd: 0.12, expectedUsd: 0.23, maxUsd: 0.29 },
          },
        }],
        sourcesView: args.sources.map((s) => ({ id: s.id, network: s.network, symbol: s.symbol, role: 'not_needed', reason: '' })),
        deliveredUsd: 344.83,
        uncoveredUsd: 525,
        costsByProfile: {
          low: { gasOriginExpectedUsd: 0.04, gasOriginMaxUsd: 0.08, bridgeCostUsd: 0.17 },
          medium: { gasOriginExpectedUsd: 0.05, gasOriginMaxUsd: 0.1, bridgeCostUsd: 0.17 },
          high: { gasOriginExpectedUsd: 0.06, gasOriginMaxUsd: 0.12, bridgeCostUsd: 0.17 },
        },
      };
    },
  };
}

function service(overrides = {}) {
  const planner = overrides.planner || fakePlanner();
  const feeOracle = overrides.feeOracle || fakeOracle();
  return {
    planner,
    feeOracle,
    svc: createCrossChainFundingService({
      balances: { getMultichainBalances: async () => overrides.balances || balances() },
      feeOracle,
      planner,
      repo: overrides.repo || {},
      getPrices: async () => ({ ETH: '2000' }),
      getWrappedNativeToken: () => ({ address: BASE_WETH }),
      providers: {},
      now: () => 42,
    }),
  };
}

const INPUT = {
  walletAddress: WALLET,
  network: 'base',
  version: 'v4',
  token0: { address: ZERO, symbol: 'ETH', decimals: 18 },
  token1: { address: BASE_USDC, symbol: 'USDC', decimals: 6 },
  totalUsdTarget: 1000,
  targetWeightToken0Pct: 50,
  profile: 'low',
  thresholdPct: 3,
};

test('sin déficit no hay plan cross-chain', async () => {
  const { svc, planner } = service({ balances: balances({ baseUsdc: 1000 }) });
  const result = await svc.analyze(INPUT);
  assert.equal(result.needsCrossChain, false);
  assert.deepEqual(result.steps, []);
  assert.equal(planner.calls.length, 0);
});

test('con déficit pasa al planificador los lados, los orígenes y el gas del LP', async () => {
  const { svc, planner, feeOracle } = service();
  const result = await svc.analyze(INPUT);
  assert.equal(result.needsCrossChain, true);
  const args = planner.calls[0];
  assert.equal(args.destination.network, 'base');
  assert.equal(args.destination.gasNeededRaw, e18(0.0005));
  assert.equal(args.destination.nativeBalanceRaw, '0');
  assert.deepEqual(args.sides?.map?.((s) => s.side), undefined);
  const sides = args.destination.sides.map((s) => [s.side, Math.round(s.deficitUsd)]);
  assert.deepEqual(sides, [['token0', 525], ['token1', 345]]);
  assert.equal(args.destination.sides[0].deliveryToken.address, ZERO);
  assert.equal(args.destination.sides[0].deliveryToken.priceUsd, 2000);
  // los orígenes son de otras redes, no del destino
  assert.ok(args.sources.every((s) => s.network !== 'base'));
  assert.ok(args.sources.some((s) => s.id === 'arbitrum:native' && s.isNative && s.address === ZERO));
  assert.equal(args.profile, 'low');
  assert.equal(args.nativePrices.arbitrum, 2000);
  // el plan del LP en destino v4: 2 approvals + 2 Permit2 + mint
  const lp = feeOracle.calls.find((c) => c.network === 'base' && c.profile === 'low');
  assert.deepEqual(lp.kinds, ['approval', 'approval', 'permit2_approval', 'permit2_approval', 'mint_position_v4']);
  assert.equal(result.destination.lacksGas, true);
});

test('las categorías de costo suman y se comparan los tres perfiles', async () => {
  const { svc } = service();
  const result = await svc.analyze(INPUT);
  const low = result.costs.byProfile.low;
  assert.equal(low.gasOrigin.expectedUsd, 0.04);
  assert.equal(low.bridgeUsd, 0.17);
  assert.ok(Math.abs(low.gasDestination.expectedUsd - 0.09) < 1e-9);
  assert.ok(Math.abs(low.totalExpectedUsd - (0.04 + 0.17 + 0.09 + low.swaps.expectedUsd)) < 1e-9);
  assert.ok(Math.abs(low.pctOfTarget - (low.totalExpectedUsd / 1000) * 100) < 1e-9);
  assert.ok(result.costs.byProfile.high.totalMaxUsd > low.totalMaxUsd);
  assert.equal(result.costs.selected, low);
});

test('la vista pública no expone el calldata de las txs', async () => {
  const { svc } = service();
  const result = await svc.analyze(INPUT);
  const json = JSON.stringify(svc.toPublicAnalysis(result));
  assert.ok(!json.includes('0xsecret'));
});

test('una red de origen ilegible aparece como no leída', async () => {
  const { svc } = service({ balances: balances({ arbStatus: 'error' }) });
  const result = await svc.analyze(INPUT);
  const arb = result.balances.networks.find((n) => n.network === 'arbitrum');
  assert.equal(arb.status, 'error');
  assert.match(arb.error, /rpc caido/);
});

test('si la red destino no se pudo leer, no hay análisis', async () => {
  const b = balances();
  b.networks[0].status = 'error';
  const { svc } = service({ balances: b });
  await assert.rejects(svc.analyze(INPUT), (err) => err.code === 'DESTINATION_UNREADABLE');
});

test('createPlan rechaza si ya hay un plan en curso o si no hace falta', async () => {
  const active = service({ repo: { findActivePlan: async () => ({ id: 1 }) } }).svc;
  await assert.rejects(active.createPlan({ userId: 1, input: INPUT }), (err) => err.code === 'ACTIVE_PLAN_EXISTS');

  const none = service({ balances: balances({ baseUsdc: 1000 }), repo: { findActivePlan: async () => null } }).svc;
  await assert.rejects(none.createPlan({ userId: 1, input: INPUT }), (err) => err.code === 'NO_CROSS_CHAIN_NEEDED');
});

test('createPlan guarda los pasos con su cotización y el análisis público', async () => {
  let saved;
  const { svc } = service({
    repo: {
      findActivePlan: async () => null,
      createPlan: async (record) => { saved = record; return { id: 9, ...record, steps: [] }; },
    },
  });
  await svc.createPlan({ userId: 3, input: INPUT });
  assert.equal(saved.userId, 3);
  assert.equal(saved.destinationNetwork, 'base');
  assert.equal(saved.profile, 'low');
  assert.equal(saved.steps[0].quoteSnapshot.quote.tx.data, '0xsecret');
  assert.equal(saved.steps[0].quoteSnapshot.amountUsd, 345);
  assert.ok(!JSON.stringify(saved.analysis).includes('0xsecret'));
});
