const test = require('node:test');
const assert = require('node:assert/strict');

const onChainManager = require('../src/services/onchain-manager.service');
const smartPoolCreatorService = require('../src/services/smart-pool-creator.service');

const HELPERS_PATH = require.resolve('../src/services/uniswap/actions/helpers');
const PREPARE_V4_PATH = require.resolve('../src/services/uniswap/actions/prepare-v4');

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 };
const NATIVE = { address: ZERO, symbol: 'ETH', decimals: 18 };
const ARB = { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18 };
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const POSITION_MANAGER = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';
const UNIVERSAL_ROUTER = '0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3';

// Lo que el wizard "Agregar liquidez" manda de verdad: solo USD y slippage.
// Ni amount0Desired ni amount1Desired — el server los deriva del plan.
const SMART_PAYLOAD = {
  network: 'arbitrum',
  version: 'v4',
  walletAddress: WALLET,
  positionIdentifier: '192675',
  totalUsdTarget: 50,
  maxSlippageBps: 50,
  fundingSelections: [{ assetId: 'native', enabled: true }],
};

function buildCtx({ token0, token1 }) {
  return {
    networkConfig: { id: 'arbitrum', chainId: 42161, label: 'Arbitrum' },
    provider: {},
    normalizedWallet: WALLET,
    tokenId: '192675',
    positionManagerAddress: POSITION_MANAGER,
    universalRouterAddress: UNIVERSAL_ROUTER,
    poolKey: { currency0: token0.address, currency1: token1.address, fee: 500, tickSpacing: 10, hooks: ZERO },
    poolId: '0xabc',
    token0,
    token1,
    tickLower: -600,
    tickUpper: 600,
    tickSpacing: 10,
    currentTick: 0,
    priceCurrent: 2000,
    positionLiquidity: 1_000_000_000n,
    currentAmounts: { amount0: '1.0', amount1: '2000.0' },
    unclaimedFeesRaw: { fees0: 0n, fees1: 0n },
  };
}

const NATIVE_CTX = () => buildCtx({ token0: NATIVE, token1: USDC });
const ERC20_CTX = () => buildCtx({ token0: WETH, token1: USDC });

/**
 * Plan de fondeo tal como lo devuelve `buildIncreaseLiquidityFundingPlan`.
 * En un pool con lado nativo el planner trabaja siempre sobre el wrapped: el
 * aporte directo de ETH se envuelve y `nativeSettlement` dice cuanto hay que
 * desenvolver antes del increase.
 */
function buildPlan({ nativeSide = false, swapPlan = [], selectedFundingAssets = [] } = {}) {
  return {
    network: 'arbitrum',
    version: 'v4',
    walletAddress: WALLET,
    token0: nativeSide ? NATIVE : WETH,
    token1: USDC,
    currentPrice: 2000,
    poolId: '0xabc',
    tickSpacing: 10,
    hooks: ZERO,
    fee: 500,
    gasReserve: { symbol: 'ETH', reservedAmount: '0.002' },
    availableFundingAssets: [{ id: 'native', symbol: 'ETH' }],
    selectedFundingAssets,
    fundingPlan: {
      totalUsdTarget: 50,
      deployableUsd: 50,
      directValueUsd: 50,
      swapValueUsd: 0,
      estimatedPoolValueUsd: 50,
      swapCount: swapPlan.length,
    },
    wrappedNativeAddress: WETH.address,
    nativeSettlement: nativeSide
      ? {
        side: 'token0',
        symbol: 'ETH',
        wrappedAddress: WETH.address,
        wrappedSymbol: 'WETH',
        unwrapRaw: (10n ** 16n).toString(),
      }
      : null,
    swapPlan,
    expectedPostSwapBalances: {
      amount0: '0.01',
      amount0Raw: (10n ** 16n).toString(),
      amount1: '23.5',
      amount1Raw: '23500000',
    },
    warnings: [],
  };
}

/**
 * `prepare-v4` desestructura sus helpers al cargar el modulo, asi que hay que
 * parchear `helpers` ANTES de requerirlo. Se aisla todo lo que sale a la red:
 * el contexto de la posicion, el planner de fondeo y las lecturas de saldo.
 */
function loadPrepareV4({ ctx, plan, onPlanArgs }) {
  delete require.cache[PREPARE_V4_PATH];
  const helpers = require(HELPERS_PATH);
  const originalHelpers = {
    loadV4PositionContext: helpers.loadV4PositionContext,
    buildEstimatedCosts: helpers.buildEstimatedCosts,
    appendPermit2Approvals: helpers.appendPermit2Approvals,
  };
  const originalPlanner = smartPoolCreatorService.buildIncreaseLiquidityFundingPlan;
  const originalAggregate = onChainManager.aggregate;

  helpers.loadV4PositionContext = async () => ctx;
  helpers.buildEstimatedCosts = async () => ({ gasUsd: 0, totalUsd: 0 });
  helpers.appendPermit2Approvals = async ({ token, spender, amount, requiresApproval, txPlan }) => {
    requiresApproval.push({ token: token.symbol, tokenAddress: token.address, spender, amount });
    txPlan.push({ to: token.address, kind: 'approval', label: `Approve ${token.symbol}` });
  };
  smartPoolCreatorService.buildIncreaseLiquidityFundingPlan = async (args) => {
    onPlanArgs?.(args);
    return plan;
  };
  // Saldo de sobra: aqui interesa QUE txs se generan, no el chequeo de fondos.
  onChainManager.aggregate = async ({ calls }) => calls.map(() => ({
    success: true,
    value: (10n ** 30n).toString(),
  }));

  const prepare = require(PREPARE_V4_PATH);
  const restore = () => {
    Object.assign(helpers, originalHelpers);
    smartPoolCreatorService.buildIncreaseLiquidityFundingPlan = originalPlanner;
    onChainManager.aggregate = originalAggregate;
    delete require.cache[PREPARE_V4_PATH];
  };
  return { prepare, restore };
}

const increaseTx = (result) => result.txPlan.find((tx) => tx && tx.kind === 'increase_liquidity_v4');
const kinds = (result) => result.txPlan.filter(Boolean).map((tx) => tx.kind);

// Regresion del caso real: sobre una posicion v4 el wizard armaba el plan de
// fondeo bien, pero al pulsar "Revisar y preparar firma" el prepare ignoraba
// `totalUsdTarget` — solo miraba amount0Desired/amount1Desired, que no vienen
// — y con ambos montos en cero reventaba con "Los montos elegidos no generan
// liquidez util para este rango". La rama smart existia en v3 y en el mint v4,
// nunca en el increase v4.
test('el increase v4 con solo totalUsdTarget usa los montos del plan de fondeo', async () => {
  const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), plan: buildPlan() });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    assert.equal(result.quoteSummary.amount0Desired, '0.01');
    assert.equal(result.quoteSummary.amount1Desired, '23.5');
    assert.ok(BigInt(result.quoteSummary.liquidityDelta) > 0n, 'la liquidez tiene que salir de los montos del plan');
    assert.ok(increaseTx(result), 'el plan debe terminar en un INCREASE_LIQUIDITY');
  } finally {
    restore();
  }
});

test('el rango y los tokens del plan salen de la posicion, no del payload', async () => {
  let planArgs = null;
  const { prepare, restore } = loadPrepareV4({
    ctx: ERC20_CTX(),
    plan: buildPlan(),
    onPlanArgs: (args) => { planArgs = args; },
  });
  try {
    await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    assert.equal(planArgs.version, 'v4');
    assert.equal(planArgs.token0Address, WETH.address);
    assert.equal(planArgs.token1Address, USDC.address);
    assert.equal(planArgs.poolId, '0xabc');
    assert.equal(planArgs.tickSpacing, 10);
    assert.equal(planArgs.fee, 500);
    assert.ok(planArgs.rangeLowerPrice > 0 && planArgs.rangeUpperPrice > planArgs.rangeLowerPrice);
    assert.equal(planArgs.totalUsdTarget, 50);
    assert.deepEqual(planArgs.fundingSelections, SMART_PAYLOAD.fundingSelections);
  } finally {
    restore();
  }
});

test('el increase smart expone fondeo y swaps para el paso de review', async () => {
  const plan = buildPlan();
  const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), plan });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    assert.equal(result.fundingPlan.estimatedPoolValueUsd, 50);
    assert.deepEqual(result.fundingPlan.selectedFundingAssets, plan.selectedFundingAssets);
    assert.deepEqual(result.fundingPlan.gasReserve, plan.gasReserve);
    assert.deepEqual(result.swapPlan, plan.swapPlan);
    assert.deepEqual(result.availableFundingAssets, plan.availableFundingAssets);
  } finally {
    restore();
  }
});

const nativeAsset = (useAmountRaw) => ({
  assetId: 'native',
  symbol: 'ETH',
  isNative: true,
  fundingRole: 'direct_token0',
  useAmountRaw: useAmountRaw.toString(),
});

// El planner contabiliza el lado nativo como wrapped, asi que el aporte
// directo de ETH se envuelve... para desenvolverse dos pasos despues. Sobre el
// pool ETH/USDC real eso son dos firmas y dos gas por nada.
test('el ETH directo no se envuelve para desenvolverlo un paso despues', async () => {
  const plan = buildPlan({ nativeSide: true, selectedFundingAssets: [nativeAsset(10n ** 16n)] });
  const { prepare, restore } = loadPrepareV4({ ctx: NATIVE_CTX(), plan });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    const orden = kinds(result);
    assert.ok(!orden.includes('wrap_native'), `viaje de ida y vuelta: ${orden.join(' -> ')}`);
    assert.ok(!orden.includes('unwrap_native'), `viaje de ida y vuelta: ${orden.join(' -> ')}`);
    assert.ok(BigInt(increaseTx(result).value) > 0n, 'el ETH que ya esta suelto paga el lado nativo');
  } finally {
    restore();
  }
});

test('solo se desenvuelve lo que el lado nativo recibe como wrapped', async () => {
  // 0.004 ETH directos de un lado nativo que totaliza 0.01: los 0.006 de
  // diferencia llegan envueltos y son los unicos que hay que desenvolver.
  const plan = buildPlan({ nativeSide: true, selectedFundingAssets: [nativeAsset(4n * 10n ** 15n)] });
  const { prepare, restore } = loadPrepareV4({ ctx: NATIVE_CTX(), plan });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    const orden = kinds(result);
    const unwrap = result.txPlan.find((tx) => tx && tx.kind === 'unwrap_native');
    assert.ok(!orden.includes('wrap_native'), 'el ETH directo ya esta en el lado correcto');
    assert.ok(unwrap, 'sin unwrap el increase no tiene ETH suelto que aportar');
    assert.equal(unwrap.amount, (6n * 10n ** 15n).toString());
    assert.ok(orden.indexOf('unwrap_native') < orden.indexOf('increase_liquidity_v4'));
  } finally {
    restore();
  }
});

// Sin lado nativo en el pool no hay nada que netear: el ETH aportado tiene que
// terminar como WETH y quedarse asi.
test('sobre un pool de dos ERC-20 el ETH directo se envuelve y no se desenvuelve', async () => {
  const plan = buildPlan({ selectedFundingAssets: [nativeAsset(10n ** 16n)] });
  const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), plan });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    const orden = kinds(result);
    const wrap = result.txPlan.find((tx) => tx && tx.kind === 'wrap_native');
    assert.ok(wrap, 'el pool cobra en WETH: el ETH tiene que envolverse');
    assert.equal(wrap.amount, (10n ** 16n).toString());
    assert.ok(!orden.includes('unwrap_native'));
    assert.equal(BigInt(increaseTx(result).value), 0n, 'mandar ETH a un pool sin lado nativo lo perderia');
  } finally {
    restore();
  }
});

test('el increase smart sobre un pool nativo no aprueba address(0) y paga con value', async () => {
  const { prepare, restore } = loadPrepareV4({ ctx: NATIVE_CTX(), plan: buildPlan({ nativeSide: true }) });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    const alaQuema = [
      ...result.requiresApproval.filter((a) => (a.tokenAddress || '').toLowerCase() === ZERO),
      ...result.txPlan.filter((tx) => tx && (tx.to || '').toLowerCase() === ZERO),
    ];
    assert.deepEqual(alaQuema, [], 'ninguna aprobacion ni tx puede apuntar a address(0)');

    const increase = increaseTx(result);
    assert.ok(BigInt(increase.value) > 0n, 'el lado nativo se aporta con el value de la tx');
    assert.ok(increase.v4Actions.includes('SWEEP'), 'sin SWEEP el sobrante del value queda atrapado');
  } finally {
    restore();
  }
});

test('los swaps del plan se firman antes del increase', async () => {
  const plan = buildPlan({
    swapPlan: [{
      tokenIn: ARB,
      tokenOut: USDC,
      amountInRaw: (10n ** 18n).toString(),
      amountOutMinimumRaw: '23000000',
      expectedOutRaw: '23500000',
      requiresWrapNative: false,
      fee: 500,
      route: { hops: [{ tokenIn: ARB, tokenOut: USDC, fee: 500 }] },
    }],
  });
  const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), plan });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4(SMART_PAYLOAD);
    const orden = kinds(result);
    const swap = orden.findIndex((kind) => String(kind).startsWith('swap'));
    assert.ok(swap !== -1, 'el plan de swaps tiene que llegar al txPlan');
    assert.ok(swap < orden.indexOf('increase_liquidity_v4'), `orden invalido: ${orden.join(' -> ')}`);
  } finally {
    restore();
  }
});

// El path viejo (amounts crudos) lo usan el orquestador y los tests de
// regresion nativos: no puede cambiar de comportamiento.
test('el path legacy con amounts crudos sigue funcionando', async () => {
  const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), plan: buildPlan() });
  try {
    const result = await prepare.prepareIncreaseLiquidityV4({
      network: 'arbitrum',
      walletAddress: WALLET,
      positionIdentifier: '192675',
      amount0Desired: '0.5',
      amount1Desired: '1000',
    });
    assert.equal(result.quoteSummary.amount0Desired, '0.5');
    assert.equal(result.quoteSummary.amount1Desired, '1000.0');
    assert.equal(result.fundingPlan, undefined, 'sin fondeo inteligente no hay plan que reportar');
  } finally {
    restore();
  }
});

test('el fixture no se desincroniza con lo que se parchea', () => {
  const helpers = require(HELPERS_PATH);
  for (const nombre of ['loadV4PositionContext', 'buildEstimatedCosts', 'appendPermit2Approvals']) {
    assert.equal(typeof helpers[nombre], 'function', `helpers.${nombre} desaparecio`);
  }
  assert.equal(typeof smartPoolCreatorService.buildIncreaseLiquidityFundingPlan, 'function');
  assert.equal(typeof onChainManager.aggregate, 'function');
});
