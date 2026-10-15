const test = require('node:test');
const assert = require('node:assert/strict');

const HELPERS_PATH = require.resolve('../src/services/uniswap/actions/helpers');
const PREPARE_V4_PATH = require.resolve('../src/services/uniswap/actions/prepare-v4');

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 };
const NATIVE = { address: ZERO, symbol: 'ETH', decimals: 18 };
const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 };
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

const ETH = 10n ** 18n;
const USD = 10n ** 6n;

/**
 * Igual que en uniswap-v4-native-redeploy.test.js: `prepare-v4` desestructura
 * sus helpers al cargar, asi que se parchean antes de requerirlo. Aqui ademas
 * se controla el saldo de la wallet, que acota lo que se puede redesplegar.
 */
function loadPrepareV4({ ctx, erc20Balances = {}, nativeBalance = 0n }) {
  delete require.cache[PREPARE_V4_PATH];
  const helpers = require(HELPERS_PATH);
  const original = {
    loadV4PositionContext: helpers.loadV4PositionContext,
    buildEstimatedCosts: helpers.buildEstimatedCosts,
    appendPermit2Approvals: helpers.appendPermit2Approvals,
    getBalancesAndAllowancesBatch: helpers.getBalancesAndAllowancesBatch,
  };
  const approvals = [];

  ctx.provider = { getBalance: async () => nativeBalance };
  helpers.loadV4PositionContext = async () => ctx;
  helpers.buildEstimatedCosts = async () => ({ gasUsd: 0, totalUsd: 0 });
  helpers.appendPermit2Approvals = async (options) => { approvals.push(options); };
  helpers.getBalancesAndAllowancesBatch = async ({ tokens }) => tokens.map((token) => ({
    balance: erc20Balances[token.symbol] ?? 0n,
  }));

  const prepare = require(PREPARE_V4_PATH);
  const restore = () => {
    Object.assign(helpers, original);
    delete require.cache[PREPARE_V4_PATH];
  };
  return { prepare, restore, approvals, helpers };
}

function buildCtx({ token0, token1, currency0, currency1, emptied = true }) {
  return {
    networkConfig: { id: 'base', chainId: 8453, label: 'Base' },
    normalizedWallet: WALLET,
    tokenId: '3110339',
    positionManagerAddress: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    universalRouterAddress: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    poolKey: { currency0, currency1, fee: 500, tickSpacing: 10, hooks: ZERO },
    poolId: '0xabc',
    token0,
    token1,
    tickLower: -600,
    tickUpper: 600,
    tickSpacing: 10,
    currentTick: 0,
    priceCurrent: 2000,
    // Un intento anterior ya mino el DECREASE: la posicion quedo vacia y el
    // capital esta en la wallet.
    positionLiquidity: emptied ? 0n : 1_000_000_000n,
    currentAmounts: emptied ? { amount0: '0', amount1: '0' } : { amount0: '1.0', amount1: '2000.0' },
    unclaimedFeesRaw: { fees0: 0n, fees1: 0n },
  };
}

const ERC20_CTX = (opts) => buildCtx({ token0: WETH, token1: USDC, currency0: WETH.address, currency1: USDC.address, ...opts });
const NATIVE_CTX = (opts) => buildCtx({ token0: NATIVE, token1: USDC, currency0: ZERO, currency1: USDC.address, ...opts });

const PAYLOAD = {
  network: 'base',
  walletAddress: WALLET,
  positionIdentifier: '3110339',
  rangeLowerPrice: 1800,
  rangeUpperPrice: 2200,
  slippageBps: 100,
  targetWeightToken0Pct: 50,
};

const RESUME = { amount0Raw: (1n * ETH).toString(), amount1Raw: (2000n * USD).toString() };

const kinds = (result) => result.txPlan.filter(Boolean).map((tx) => tx.kind);

for (const [nombre, preparar, emptyMessage] of [
  ['modify-range', (p, payload) => p.prepareModifyRangeV4(payload), /no tiene liquidez ni fees que redesplegar/],
  ['rebalance', (p, payload) => p.prepareRebalanceV4(payload), /no tiene liquidez ni fees que rebalancear/],
]) {
  test(`${nombre}: con la posicion ya vaciada y resumeFunding, retoma sin volver a retirar`, async () => {
    const { prepare, restore } = loadPrepareV4({
      ctx: ERC20_CTX(),
      erc20Balances: { WETH: 5n * ETH, USDC: 5000n * USD },
    });
    try {
      const result = await preparar(prepare, { ...PAYLOAD, resumeFunding: RESUME });
      assert.ok(!kinds(result).includes('decrease_liquidity_v4'), 'el retiro ya se mino: repetirlo revierte');
      assert.ok(kinds(result).includes('mint_position_v4'), 'el plan tiene que llegar al mint');
      assert.equal(result.quoteSummary.resumed, true);
      assert.ok(!result.quoteSummary.v4ActionPlan.includes('DECREASE_LIQUIDITY'));
      assert.equal(result.positionIdentifier, '3110339', 'finalize migra la proteccion desde la posicion vieja');
      // Solo se redespliega lo que libero el retiro, no el resto de la wallet.
      assert.deepEqual(result.quoteSummary.redeployFunding, RESUME);
    } finally {
      restore();
    }
  });

  test(`${nombre}: sin resumeFunding una posicion vacia sigue fallando con el mensaje claro`, async () => {
    const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX(), erc20Balances: { WETH: 5n * ETH, USDC: 5000n * USD } });
    try {
      await assert.rejects(() => preparar(prepare, PAYLOAD), emptyMessage);
    } finally {
      restore();
    }
  });

  test(`${nombre}: el capital retomado se acota al saldo real de la wallet`, async () => {
    const { prepare, restore } = loadPrepareV4({
      ctx: ERC20_CTX(),
      erc20Balances: { WETH: 5n * ETH, USDC: 1500n * USD },
    });
    try {
      const result = await preparar(prepare, { ...PAYLOAD, resumeFunding: RESUME });
      assert.deepEqual(result.quoteSummary.redeployFunding, {
        amount0Raw: RESUME.amount0Raw,
        amount1Raw: (1500n * USD).toString(),
      });
    } finally {
      restore();
    }
  });

  test(`${nombre}: el lado nativo retomado deja la reserva de gas en la wallet`, async () => {
    const { prepare, restore, helpers } = loadPrepareV4({
      ctx: NATIVE_CTX(),
      erc20Balances: { USDC: 5000n * USD },
      nativeBalance: 1n * ETH,
    });
    try {
      const reserve = helpers.getGasReserveRaw('base');
      const result = await preparar(prepare, { ...PAYLOAD, resumeFunding: RESUME });
      assert.equal(result.quoteSummary.redeployFunding.amount0Raw, (1n * ETH - reserve).toString());
    } finally {
      restore();
    }
  });

  test(`${nombre}: sin fondos en la wallet no arma un plan vacio`, async () => {
    const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX() });
    try {
      await assert.rejects(
        () => preparar(prepare, { ...PAYLOAD, resumeFunding: RESUME }),
        /ya no tiene los fondos/
      );
    } finally {
      restore();
    }
  });

  test(`${nombre}: si la posicion sigue viva ignora resumeFunding y retira primero`, async () => {
    const { prepare, restore } = loadPrepareV4({
      ctx: ERC20_CTX({ emptied: false }),
      erc20Balances: { WETH: 5n * ETH, USDC: 5000n * USD },
    });
    try {
      const result = await preparar(prepare, { ...PAYLOAD, resumeFunding: RESUME });
      assert.equal(kinds(result)[0], 'decrease_liquidity_v4');
      assert.equal(result.quoteSummary.resumed, false);
    } finally {
      restore();
    }
  });

  test(`${nombre}: el plan normal expone el capital que libera el retiro, para poder retomarlo`, async () => {
    const { prepare, restore } = loadPrepareV4({ ctx: ERC20_CTX({ emptied: false }) });
    try {
      const result = await preparar(prepare, PAYLOAD);
      assert.deepEqual(result.quoteSummary.redeployFunding, RESUME);
      const post = result.quoteSummary.postSwapFunding;
      assert.match(post.amount0Raw, /^\d+$/);
      assert.match(post.amount1Raw, /^\d+$/);
    } finally {
      restore();
    }
  });
}
