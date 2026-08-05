const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HELPERS_PATH = require.resolve('../src/services/uniswap/actions/helpers');
const PREPARE_V4_PATH = require.resolve('../src/services/uniswap/actions/prepare-v4');

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const NATIVE = { address: ZERO, symbol: 'ETH', decimals: 18 };
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 };
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const POSITION_MANAGER = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';
const UNIVERSAL_ROUTER = '0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3';

/**
 * `prepare-v4` desestructura sus helpers al cargar el modulo, asi que hay que
 * parchear `helpers` ANTES de requerirlo. Se aisla lo que sale a la red: el
 * contexto de la posicion, el costeo de gas y el saldo de Permit2.
 */
function loadPrepareV4WithContext(ctx) {
  delete require.cache[PREPARE_V4_PATH];
  const helpers = require(HELPERS_PATH);
  const original = {
    loadV4PositionContext: helpers.loadV4PositionContext,
    buildEstimatedCosts: helpers.buildEstimatedCosts,
    appendPermit2Approvals: helpers.appendPermit2Approvals,
  };

  helpers.loadV4PositionContext = async () => ctx;
  helpers.buildEstimatedCosts = async () => ({ gasUsd: 0, totalUsd: 0 });
  // La wallet siempre tiene de sobra: aqui interesa QUE txs se generan, no el
  // chequeo de saldo (cubierto en uniswap-v4-approval-balance.test.js).
  helpers.appendPermit2Approvals = async ({ token, spender, amount, requiresApproval, txPlan }) => {
    requiresApproval.push({ token: token.symbol, tokenAddress: token.address, spender, amount });
    txPlan.push({ to: token.address, kind: 'approval', label: `Approve ${token.symbol}` });
  };

  const prepare = require(PREPARE_V4_PATH);
  const restore = () => {
    Object.assign(helpers, original);
    delete require.cache[PREPARE_V4_PATH];
  };
  return { prepare, restore };
}

function buildCtx({ token0, token1, currency0, currency1 }) {
  return {
    networkConfig: { id: 'arbitrum', chainId: 42161, label: 'Arbitrum' },
    provider: {},
    normalizedWallet: WALLET,
    tokenId: '12345',
    positionManagerAddress: POSITION_MANAGER,
    universalRouterAddress: UNIVERSAL_ROUTER,
    poolKey: { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ZERO },
    poolId: '0xabc',
    token0,
    token1,
    tickLower: -600,
    tickUpper: 600,
    tickSpacing: 60,
    currentTick: 0,
    priceCurrent: 2000,
    positionLiquidity: 1_000_000_000n,
    // 1 ETH + 2000 USDC dentro de la posicion, nada suelto en la wallet.
    currentAmounts: { amount0: '1.0', amount1: '2000.0' },
    unclaimedFeesRaw: { fees0: 0n, fees1: 0n },
  };
}

const NATIVE_CTX = () => buildCtx({
  token0: NATIVE, token1: USDC, currency0: ZERO, currency1: USDC.address,
});
const ERC20_CTX = () => buildCtx({
  token0: WETH, token1: USDC, currency0: WETH.address, currency1: USDC.address,
});

const PAYLOAD = {
  network: 'arbitrum',
  walletAddress: WALLET,
  positionIdentifier: '12345',
  rangeLowerPrice: 1800,
  rangeUpperPrice: 2200,
  slippageBps: 100,
  targetWeightToken0Pct: 50,
};

function approvalsToBurnAddress(result) {
  return [
    ...result.requiresApproval.filter((a) => (a.tokenAddress || '').toLowerCase() === ZERO),
    ...result.txPlan.filter((tx) => tx && (tx.to || '').toLowerCase() === ZERO),
  ];
}

function mintTx(result) {
  return result.txPlan.find((tx) => tx && tx.kind === 'mint_position_v4');
}

// Regresion de lo que MetaMask anuncio como "Envio de activos a la direccion
// de quema": sobre un pool v4 con ETH nativo, el redespliegue aprobaba
// address(0) como si fuera un ERC-20, y la tx de aprobacion iba dirigida
// literalmente a la direccion cero. create-position ya tenia el tratamiento;
// modify-range, rebalance e increase se quedaron sin el.
for (const [nombre, preparar] of [
  ['modify-range', (p) => p.prepareModifyRangeV4(PAYLOAD)],
  ['rebalance', (p) => p.prepareRebalanceV4(PAYLOAD)],
]) {
  test(`${nombre} sobre un pool nativo no manda nada a la direccion de quema`, async () => {
    const { prepare, restore } = loadPrepareV4WithContext(NATIVE_CTX());
    try {
      const result = await preparar(prepare);
      assert.deepEqual(
        approvalsToBurnAddress(result),
        [],
        'ninguna aprobacion ni tx puede apuntar a address(0)'
      );
    } finally {
      restore();
    }
  });

  test(`${nombre} sobre un pool nativo paga el lado nativo con value y barre el sobrante`, async () => {
    const { prepare, restore } = loadPrepareV4WithContext(NATIVE_CTX());
    try {
      const result = await preparar(prepare);
      const mint = mintTx(result);
      assert.ok(mint, 'el plan debe redesplegar la liquidez');
      assert.ok(
        BigInt(mint.value) > 0n,
        'sin value el PositionManager no puede liquidar el lado nativo'
      );
      assert.ok(
        mint.v4Actions.includes('SWEEP'),
        'sin SWEEP el sobrante del value queda atrapado en el PositionManager'
      );
      assert.ok(
        result.quoteSummary.v4ActionPlan.includes('SWEEP'),
        'el resumen debe reflejar lo que realmente se firma'
      );
    } finally {
      restore();
    }
  });

  test(`${nombre} sobre un pool de dos ERC-20 no manda value ni SWEEP`, async () => {
    const { prepare, restore } = loadPrepareV4WithContext(ERC20_CTX());
    try {
      const result = await preparar(prepare);
      const mint = mintTx(result);
      assert.ok(mint);
      assert.equal(BigInt(mint.value), 0n, 'mandar ETH a un pool sin lado nativo lo perderia');
      assert.ok(!mint.v4Actions.includes('SWEEP'));
    } finally {
      restore();
    }
  });
}

test('increase-liquidity sobre un pool nativo tampoco aprueba address(0)', async () => {
  const { prepare, restore } = loadPrepareV4WithContext(NATIVE_CTX());
  try {
    const result = await prepare.prepareIncreaseLiquidityV4({
      ...PAYLOAD,
      amount0Desired: '0.5',
      amount1Desired: '1000',
    });
    assert.deepEqual(approvalsToBurnAddress(result), []);

    const increase = result.txPlan.find((tx) => tx && tx.kind === 'increase_liquidity_v4');
    assert.ok(BigInt(increase.value) > 0n, 'el lado nativo se aporta con el value de la tx');
    assert.ok(increase.v4Actions.includes('SWEEP'));
    assert.ok(result.quoteSummary.v4ActionPlan.includes('SWEEP'));
  } finally {
    restore();
  }
});

test('increase-liquidity sobre dos ERC-20 aprueba ambos lados y no manda value', async () => {
  const { prepare, restore } = loadPrepareV4WithContext(ERC20_CTX());
  try {
    const result = await prepare.prepareIncreaseLiquidityV4({
      ...PAYLOAD,
      amount0Desired: '0.5',
      amount1Desired: '1000',
    });
    assert.deepEqual(
      result.requiresApproval.map((a) => a.token).sort(),
      ['USDC', 'WETH'],
      'los dos lados ERC-20 siguen necesitando aprobacion'
    );
    const increase = result.txPlan.find((tx) => tx && tx.kind === 'increase_liquidity_v4');
    assert.equal(BigInt(increase.value), 0n);
  } finally {
    restore();
  }
});

test('el swap que entrega ETH nativo lo manda como value, no lo aprueba', async () => {
  // Pesos muy desbalanceados para forzar un swap del lado nativo hacia USDC.
  const ctx = NATIVE_CTX();
  ctx.currentAmounts = { amount0: '10.0', amount1: '0.0' };
  const { prepare, restore } = loadPrepareV4WithContext(ctx);
  try {
    const result = await prepare.prepareModifyRangeV4(PAYLOAD);
    const swapTx = result.txPlan.find((tx) => tx && tx.kind === 'swap_v4');
    assert.ok(swapTx, 'con todo el capital de un lado tiene que haber swap');
    assert.ok(BigInt(swapTx.value) > 0n, 'el Universal Router recibe el ETH como value');
    assert.deepEqual(approvalsToBurnAddress(result), []);
  } finally {
    restore();
  }
});

test(`el fixture no se desincroniza: ${path.basename(HELPERS_PATH)} sigue exportando lo parcheado`, () => {
  const helpers = require(HELPERS_PATH);
  for (const nombre of ['loadV4PositionContext', 'buildEstimatedCosts', 'appendPermit2Approvals']) {
    assert.equal(typeof helpers[nombre], 'function', `helpers.${nombre} desaparecio`);
  }
});
