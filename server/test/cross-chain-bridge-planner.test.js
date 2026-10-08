const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBridgePlan, orderSteps } = require('../src/services/cross-chain/bridge-planner');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const ZERO = '0x0000000000000000000000000000000000000000';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const POL_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ETH_PRICE = 2000;

const e18 = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const e6 = (n) => BigInt(Math.round(n * 1e6));

/**
 * Proveedor falso: entrega `amount × (1 − feePct)` convertido por precio entre
 * el token de origen y el de destino, y lanza si la red está en `fail`.
 */
function fakeProvider(id, { feePct = {}, fail = [], extraFeeUsd = 0 } = {}) {
  const calls = [];
  return {
    id,
    calls,
    async quote(args) {
      calls.push(args);
      if (fail.includes(args.fromNetwork)) throw Object.assign(new Error(`${id} sin ruta`), { code: 'BRIDGE_QUOTE_FAILED' });
      const fee = feePct[args.fromNetwork] ?? 0.001;
      const fromNative = args.fromToken === ZERO;
      const toNative = args.toToken === ZERO;
      const fromUsd = fromNative ? Number(BigInt(args.fromAmountRaw)) / 1e18 * ETH_PRICE : Number(BigInt(args.fromAmountRaw)) / 1e6;
      const toUsd = fromUsd * (1 - fee);
      const toAmountRaw = toNative ? e18(toUsd / ETH_PRICE) : e6(toUsd);
      return {
        provider: id,
        tool: id,
        fromNetwork: args.fromNetwork,
        toNetwork: args.toNetwork,
        fromToken: args.fromToken,
        toToken: args.toToken,
        fromAmountRaw: String(args.fromAmountRaw),
        toAmountRaw: toAmountRaw.toString(),
        toAmountMinRaw: toAmountRaw.toString(),
        feeCosts: [
          { name: `${id} fee`, amountUsd: fromUsd * fee, included: true },
          ...(extraFeeUsd ? [{ name: 'Gas en destino', amountUsd: extraFeeUsd, included: false }] : []),
        ],
        approvalTxs: fromNative ? [] : [{ to: args.fromToken, data: '0x095ea7b3', value: '0', spender: '0xspender' }],
        tx: { to: '0xbridge', data: '0xfeed', value: fromNative ? String(args.fromAmountRaw) : '0', chainId: 1, gasLimit: '200000' },
        etaSec: 60,
        expiresAt: null,
        ref: {},
      };
    },
  };
}

// Gas por tx en USD según red y perfil; reserva de 0,001 ETH por tx.
const GAS_USD = {
  arbitrum: { low: 0.02, medium: 0.03, high: 0.05 },
  ethereum: { low: 2, medium: 3, high: 5 },
  polygon: { low: 0.01, medium: 0.01, high: 0.02 },
  robinhood: { low: 0.02, medium: 0.02, high: 0.02 },
};
const fakeOracle = {
  async estimateTxCosts({ network, profile, txs }) {
    const per = GAS_USD[network]?.[profile] ?? 0.01;
    return {
      txs: txs.map((tx) => ({ kind: tx.kind, label: tx.label, expectedUsd: per, maxUsd: per * 2, l1Usd: 0 })),
      totalExpectedUsd: per * txs.length,
      totalMaxUsd: per * 2 * txs.length,
      totalMaxWei: (BigInt(txs.length) * 10n ** 15n).toString(),
      profilesMatter: network !== 'arbitrum',
    };
  },
};

function destination({ nativeBalanceRaw = e18(0.01).toString(), gasNeededRaw = e18(0.0005).toString(), sides } = {}) {
  return {
    network: 'base',
    nativeSymbol: 'ETH',
    nativeBalanceRaw,
    gasNeededRaw,
    nativePriceUsd: ETH_PRICE,
    sides: sides || [
      { side: 'token1', deficitUsd: 345, deliveryToken: { address: BASE_USDC, symbol: 'USDC', decimals: 6, isNative: false, priceUsd: 1 } },
    ],
  };
}

const ARB_USDC_SRC = { id: 'arbitrum:usdc', network: 'arbitrum', address: ARB_USDC, symbol: 'USDC', decimals: 6, isNative: false, balanceRaw: e6(420).toString(), priceUsd: 1 };
const ARB_ETH_SRC = { id: 'arbitrum:native', network: 'arbitrum', address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: e18(0.3).toString(), priceUsd: ETH_PRICE };
const ETH_ETH_SRC = { id: 'ethereum:native', network: 'ethereum', address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: e18(0.03).toString(), priceUsd: ETH_PRICE };
const POL_USDC_SRC = { id: 'polygon:usdc', network: 'polygon', address: POL_USDC, symbol: 'USDC', decimals: 6, isNative: false, balanceRaw: e6(40).toString(), priceUsd: 1 };

function plan(overrides = {}) {
  return buildBridgePlan({
    walletAddress: WALLET,
    destination: destination(),
    sources: [ARB_USDC_SRC],
    profile: 'low',
    thresholdPct: 3,
    forcedSources: [],
    disabledSources: [],
    maxSlippageBps: 50,
    providers: [fakeProvider('lifi', { feePct: { arbitrum: 0.003 } }), fakeProvider('across', { feePct: { arbitrum: 0.0005 } })],
    feeOracle: fakeOracle,
    nativePrices: { arbitrum: ETH_PRICE, ethereum: ETH_PRICE, polygon: 0.23, robinhood: ETH_PRICE },
    ...overrides,
  });
}

test('gana el proveedor más barato y el otro queda como alternativa', async () => {
  const result = await plan();
  assert.equal(result.steps.length, 1);
  const [step] = result.steps;
  assert.equal(step.provider, 'across');
  assert.equal(step.alternative.provider, 'lifi');
  assert.ok(step.alternative.costUsd > step.costs.expectedUsd);
  assert.equal(step.amountRaw, e6(345).toString(), 'USDC con 6 decimales');
  assert.equal(step.order, 1);
  assert.equal(step.side, 'token1');
  // costo = (345 − 345 × 0,9995) del bridge + 2 txs (approve + bridge) × 0,02
  assert.ok(Math.abs(step.costs.bridgeCostUsd - 0.1725) < 1e-6);
  assert.ok(Math.abs(step.costs.gasOrigin.expectedUsd - 0.04) < 1e-9);
  assert.ok(Math.abs(step.costs.expectedUsd - 0.2125) < 1e-6);
  assert.equal(result.uncoveredUsd, 0);
  const view = result.sourcesView.find((s) => s.id === 'arbitrum:usdc');
  assert.equal(view.role, 'used');
  assert.equal(view.usedAmountRaw, e6(345).toString());
});

test('los costos por perfil comparan el gas de origen con el mismo bridge', async () => {
  const result = await plan();
  const [step] = result.steps;
  assert.ok(step.costsByProfile.low.expectedUsd < step.costsByProfile.high.expectedUsd);
  assert.ok(Math.abs(result.costsByProfile.medium.gasOriginExpectedUsd - 0.06) < 1e-9);
  assert.ok(Math.abs(result.costsByProfile.low.bridgeCostUsd - result.costsByProfile.high.bridgeCostUsd) < 1e-12);
});

test('una comisión no incluida en el monto se suma al costo', async () => {
  const result = await plan({ providers: [fakeProvider('lifi', { feePct: { arbitrum: 0.001 }, extraFeeUsd: 0.5 })] });
  assert.ok(Math.abs(result.steps[0].costs.bridgeCostUsd - (0.345 + 0.5)) < 1e-6);
});

test('un origen caro queda excluido con motivo salvo que se fuerce', async () => {
  const dest = destination({
    sides: [{ side: 'token0', deficitUsd: 50, deliveryToken: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, priceUsd: ETH_PRICE } }],
  });
  const result = await plan({ destination: dest, sources: [ETH_ETH_SRC] });
  assert.equal(result.steps.length, 0);
  const view = result.sourcesView.find((s) => s.id === 'ethereum:native');
  assert.equal(view.role, 'excluded');
  assert.match(view.reason, /> umbral 3 %/);
  assert.ok(result.uncoveredUsd > 49);

  const forced = await plan({ destination: dest, sources: [ETH_ETH_SRC], forcedSources: ['ethereum:native'] });
  assert.equal(forced.steps.length, 1);
  assert.equal(forced.steps[0].forced, true);
});

test('un origen desactivado no se usa', async () => {
  const result = await plan({ sources: [ARB_USDC_SRC, POL_USDC_SRC], disabledSources: ['arbitrum:usdc'] });
  assert.ok(result.steps.every((s) => s.sourceId !== 'arbitrum:usdc'));
  assert.equal(result.sourcesView.find((s) => s.id === 'arbitrum:usdc').role, 'disabled');
});

test('sin precio un origen se excluye con motivo', async () => {
  const noPrice = { ...POL_USDC_SRC, id: 'polygon:pepe', symbol: 'PEPE', priceUsd: null };
  const result = await plan({ sources: [ARB_USDC_SRC, noPrice] });
  const view = result.sourcesView.find((s) => s.id === 'polygon:pepe');
  assert.equal(view.role, 'no_price');
  assert.match(view.reason, /sin precio/i);
});

test('sin ruta en ningún proveedor el origen queda marcado y el plan sigue', async () => {
  const result = await plan({
    sources: [POL_USDC_SRC, ARB_USDC_SRC],
    providers: [fakeProvider('lifi', { fail: ['polygon'] }), fakeProvider('across', { fail: ['polygon'] })],
  });
  assert.equal(result.sourcesView.find((s) => s.id === 'polygon:usdc').role, 'no_route');
  assert.equal(result.steps[0].sourceId, 'arbitrum:usdc');
});

test('el nativo de origen deja su reserva de gas', async () => {
  const dest = destination({
    sides: [{ side: 'token0', deficitUsd: 5000, deliveryToken: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, priceUsd: ETH_PRICE } }],
  });
  const result = await plan({ destination: dest, sources: [ARB_ETH_SRC] });
  const [step] = result.steps;
  // reserva = 5 txs × 0,001 ETH = 0,005 ETH
  assert.equal(step.amountRaw, (e18(0.3) - e18(0.005)).toString());
  assert.ok(result.uncoveredUsd > 0);
});

test('un nativo por debajo de su reserva queda como reserva de gas', async () => {
  const tiny = { ...ARB_ETH_SRC, balanceRaw: e18(0.004).toString() };
  const result = await plan({ sources: [tiny, ARB_USDC_SRC] });
  assert.equal(result.sourcesView.find((s) => s.id === 'arbitrum:native').role, 'gas_reserve');
});

test('si el destino no tiene gas, el envío que lo lleva va primero', async () => {
  const dest = destination({
    nativeBalanceRaw: '0',
    gasNeededRaw: e18(0.001).toString(),
    sides: [
      { side: 'token1', deficitUsd: 345, deliveryToken: { address: BASE_USDC, symbol: 'USDC', decimals: 6, isNative: false, priceUsd: 1 } },
      { side: 'token0', deficitUsd: 500, deliveryToken: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, priceUsd: ETH_PRICE } },
    ],
  });
  const result = await plan({ destination: dest, sources: [ARB_USDC_SRC, ARB_ETH_SRC, { ...ARB_USDC_SRC, id: 'robinhood:usdg', network: 'robinhood', address: RH_USDG, symbol: 'USDG', balanceRaw: e6(1000).toString() }] });
  const carrier = result.steps.find((s) => s.carriesDestinationGas);
  assert.ok(carrier, 'algún envío lleva el gas de destino');
  assert.equal(carrier.deliveryToken.isNative, true);
  // su red va primero, y dentro de la red los ERC20 antes que el nativo
  assert.equal(result.steps[0].sourceNetwork, carrier.sourceNetwork);
  const arb = result.steps.filter((s) => s.sourceNetwork === 'arbitrum');
  assert.deepEqual(arb.map((s) => s.token.isNative), [false, true]);
  // el lado ETH absorbe el gas faltante (0,0012 ETH = 2,4 USD)
  const ethSide = result.steps.filter((s) => s.side === 'token0').reduce((a, s) => a + s.amountUsd, 0);
  assert.ok(ethSide > 500 + 2.3);
});

test('sin lado nativo con déficit, el gas viaja en un envío propio de al menos 3 USD', async () => {
  const dest = destination({ nativeBalanceRaw: '0', gasNeededRaw: e18(0.0001).toString() });
  const result = await plan({ destination: dest, sources: [ARB_USDC_SRC] });
  const gas = result.steps.find((s) => s.side === 'gas');
  assert.ok(gas);
  assert.equal(gas.carriesDestinationGas, true);
  assert.equal(result.steps[0].sourceNetwork, gas.sourceNetwork);
  assert.equal(gas.deliveryToken.address, ZERO);
  assert.ok(gas.amountUsd >= 3 - 1e-9);
});

test('orderSteps: el que lleva gas primero, y en cada red ERC20 antes que nativo', () => {
  const steps = [
    { sourceNetwork: 'arbitrum', token: { isNative: true }, carriesDestinationGas: false, tag: 'arb-eth' },
    { sourceNetwork: 'polygon', token: { isNative: false }, carriesDestinationGas: true, tag: 'pol-usdc-gas' },
    { sourceNetwork: 'arbitrum', token: { isNative: false }, carriesDestinationGas: false, tag: 'arb-usdc' },
    { sourceNetwork: 'polygon', token: { isNative: true }, carriesDestinationGas: false, tag: 'pol-pol' },
  ];
  const ordered = orderSteps(steps);
  assert.deepEqual(ordered.map((s) => s.tag), ['pol-usdc-gas', 'pol-pol', 'arb-usdc', 'arb-eth']);
  assert.deepEqual(ordered.map((s) => s.order), [1, 2, 3, 4]);
});

test('USDG de destino con 6 decimales: el monto recibido se valora bien', async () => {
  const dest = { ...destination(), network: 'robinhood', sides: [{ side: 'token1', deficitUsd: 100, deliveryToken: { address: RH_USDG, symbol: 'USDG', decimals: 6, isNative: false, priceUsd: 1 } }] };
  const result = await plan({ destination: dest });
  assert.ok(Math.abs(result.steps[0].receivedUsd - 100 * 0.9995) < 1e-6);
  assert.ok(Math.abs(result.deliveredUsd - 99.95) < 1e-6);
});

test('si el gas de una red de origen no se puede leer, sus orígenes quedan fuera y el resto sigue', async () => {
  const brokenOracle = {
    async estimateTxCosts(args) {
      if (args.network === 'robinhood') throw new Error('ROBINHOOD_MAINNET is not enabled for this app');
      return fakeOracle.estimateTxCosts(args);
    },
  };
  const rhNative = { id: 'robinhood:native', network: 'robinhood', address: ZERO, symbol: 'ETH', decimals: 18, isNative: true, balanceRaw: e18(1).toString(), priceUsd: ETH_PRICE };
  const rhUsdg = { ...ARB_USDC_SRC, id: 'robinhood:usdg', network: 'robinhood', address: RH_USDG, symbol: 'USDG', balanceRaw: e6(5000).toString() };
  const result = await plan({ sources: [rhNative, rhUsdg, ARB_USDC_SRC], feeOracle: brokenOracle });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].sourceId, 'arbitrum:usdc');
  for (const id of ['robinhood:native', 'robinhood:usdg']) {
    const view = result.sourcesView.find((s) => s.id === id);
    assert.equal(view.role, 'no_route', id);
    assert.match(view.reason, /gas/i);
  }
});

test('el motivo nunca expone la URL del RPC (ni su API key)', async () => {
  const leaky = {
    async estimateTxCosts(args) {
      if (args.network === 'robinhood') {
        const err = new Error('server response 403 Forbidden (request={  }, info={ "requestUrl": "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123" })');
        err.shortMessage = 'server response 403 Forbidden';
        throw err;
      }
      return fakeOracle.estimateTxCosts(args);
    },
  };
  const noShort = {
    async estimateTxCosts(args) {
      if (args.network === 'robinhood') throw new Error('fallo en https://rpc.example.com/v2/SECRETKEY123 al leer');
      return fakeOracle.estimateTxCosts(args);
    },
  };
  const rh = { ...ARB_USDC_SRC, id: 'robinhood:usdg', network: 'robinhood', address: RH_USDG, symbol: 'USDG' };
  for (const feeOracle of [leaky, noShort]) {
    const result = await plan({ sources: [rh, ARB_USDC_SRC], feeOracle });
    const reason = result.sourcesView.find((s) => s.id === 'robinhood:usdg').reason;
    assert.ok(!reason.includes('SECRETKEY123'), reason);
    assert.ok(!/https?:\/\//.test(reason), reason);
  }
});


test('un lado cuyo token de destino no tiene precio queda sin cubrir, sin NaN ni envíos', async () => {
  const dest = destination({
    sides: [{ side: 'token0', deficitUsd: 100, deliveryToken: { address: '0x00000000000000000000000000000000000000aa', symbol: 'RARO', decimals: 18, isNative: false, priceUsd: null } }],
  });
  const result = await plan({ destination: dest, sources: [ARB_USDC_SRC], forcedSources: ['arbitrum:usdc'] });
  assert.equal(result.steps.length, 0);
  assert.equal(result.uncoveredUsd, 100);
});
