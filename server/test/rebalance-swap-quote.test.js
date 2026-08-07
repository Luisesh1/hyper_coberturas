const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const onChainManager = require('../src/services/onchain-manager.service');
const {
  applyQuotedSwapOut,
  buildRebalanceSwap,
} = require('../src/domains/uniswap/pools/domain/position-action-math');
const { quoteV3SwapOutRaw, quoteV4SwapOutRaw } = require('../src/services/uniswap/actions/helpers');

// `buildRebalanceSwap` valora el input al precio spot y no descuenta ni el fee
// del pool ni el price impact. En un pool de fee 10000 el fee solo ya se come
// los 100 bps de slippage por defecto: el margen efectivo queda en ~0 y basta
// un poco de impact o de deriva de precio para revertir con "Too little
// received". Medido en Arbitrum con 0.2 WETH quedaban 14 bps de los 100. La
// cotizacion real devuelve ese presupuesto a lo que es, movimiento de precio.

const WETH = { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 };
const USDC = { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 };
const CTX = { token0: WETH, token1: USDC, priceCurrent: 2000 };

function buildDraftSwap() {
  return buildRebalanceSwap(CTX, {
    amount0Available: ethers.parseUnits('2', 18),
    amount1Available: 0n,
    targetWeightToken0Pct: 50,
    slippageBps: 100,
  });
}

test('en un pool de fee 10000 la estimacion spot no deja margen de slippage', () => {
  const draft = buildDraftSwap();
  assert.equal(draft.amountIn, ethers.parseUnits('1', 18));
  // 1 WETH a 2000 => 2000 USDC "esperados", sin restar el 1% de fee.
  assert.equal(draft.amountOutMinimum, ethers.parseUnits('1980', 6));
  // El fee se lleva exactamente los 100 bps del presupuesto: el minimo queda
  // pegado a lo que el pool entrega y cualquier impact lo tumba.
  const salidaSoloFee = ethers.parseUnits('1980', 6);
  assert.equal(salidaSoloFee, draft.amountOutMinimum);
  assert.ok(ethers.parseUnits('1979', 6) < draft.amountOutMinimum, 'con impact ya revierte');
});

test('applyQuotedSwapOut baja el minimo a la cotizacion real y ajusta el post-swap', () => {
  const draft = buildDraftSwap();
  const quoted = applyQuotedSwapOut(draft, {
    quotedOutRaw: ethers.parseUnits('1979', 6),
    slippageBps: 100,
  });

  assert.equal(quoted.expectedOutRaw, ethers.parseUnits('1979', 6));
  assert.equal(quoted.amountOutMinimum, ethers.parseUnits('1959.21', 6));
  assert.equal(quoted.quoteSource, 'quoter');
  // Ahora el minimo si se cumple.
  assert.ok(ethers.parseUnits('1979', 6) >= quoted.amountOutMinimum);
  // El token recibido es token1: su post-swap sigue al minimo corregido.
  assert.equal(quoted.postAmount1, ethers.parseUnits('1959.21', 6));
  assert.equal(quoted.postAmount0, draft.postAmount0);
  assert.equal(quoted.amountIn, draft.amountIn);
});

test('applyQuotedSwapOut ajusta postAmount0 cuando el swap va token1 -> token0', () => {
  const draft = buildRebalanceSwap(CTX, {
    amount0Available: 0n,
    amount1Available: ethers.parseUnits('4000', 6),
    targetWeightToken0Pct: 50,
    slippageBps: 100,
  });
  assert.equal(draft.direction, 'token1_to_token0');

  const quotedOutRaw = ethers.parseUnits('0.98', 18);
  const quoted = applyQuotedSwapOut(draft, { quotedOutRaw, slippageBps: 100 });
  assert.equal(quoted.postAmount0, ethers.parseUnits('0.9702', 18));
  assert.equal(quoted.postAmount1, draft.postAmount1);
});

test('sin cotizacion el swap se queda como estaba', () => {
  const draft = buildDraftSwap();
  assert.equal(applyQuotedSwapOut(draft, { quotedOutRaw: null, slippageBps: 100 }), draft);
  assert.equal(applyQuotedSwapOut(draft, { quotedOutRaw: 0n, slippageBps: 100 }), draft);
  assert.equal(applyQuotedSwapOut(null, { quotedOutRaw: 1n, slippageBps: 100 }), null);
});

// ─── Cotizadores ────────────────────────────────────────────────────

function stubQuoter(impl) {
  const original = onChainManager.getContract;
  onChainManager.getContract = () => ({ quoteExactInputSingle: { staticCall: impl } });
  return () => { onChainManager.getContract = original; };
}

const V3_NETWORK = { id: 'arbitrum', deployments: { v3: { quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' } } };
const V4_NETWORK = { id: 'arbitrum', deployments: { v4: { quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5' } } };
const POOL_KEY = {
  currency0: WETH.address,
  currency1: USDC.address,
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};

test('quoteV3SwapOutRaw cotiza contra el fee tier del pool de la posicion', async () => {
  let seen = null;
  const restore = stubQuoter(async (params) => { seen = params; return [ethers.parseUnits('1979', 6), 0n, 0, 0n]; });
  try {
    const out = await quoteV3SwapOutRaw({
      provider: {},
      networkConfig: V3_NETWORK,
      swap: buildDraftSwap(),
      fee: 10000,
    });
    assert.equal(out, ethers.parseUnits('1979', 6));
    assert.equal(seen.fee, 10000);
    assert.equal(seen.tokenIn, WETH.address);
    assert.equal(seen.tokenOut, USDC.address);
  } finally {
    restore();
  }
});

test('quoteV4SwapOutRaw cotiza contra el poolKey de la posicion', async () => {
  let seen = null;
  const restore = stubQuoter(async (params) => { seen = params; return [ethers.parseUnits('1979', 6), 0n]; });
  try {
    const out = await quoteV4SwapOutRaw({
      provider: {},
      networkConfig: V4_NETWORK,
      poolKey: POOL_KEY,
      swap: buildDraftSwap(),
    });
    assert.equal(out, ethers.parseUnits('1979', 6));
    assert.equal(seen.poolKey.fee, 3000);
    assert.equal(seen.poolKey.tickSpacing, 60);
    // token0 -> token1 es zeroForOne en el pool.
    assert.equal(seen.zeroForOne, true);
    assert.equal(seen.exactAmount, ethers.parseUnits('1', 18));
  } finally {
    restore();
  }
});

test('una cotizacion que revierte devuelve null y deja el plan con la estimacion previa', async () => {
  const restore = stubQuoter(async () => { throw new Error('execution reverted'); });
  try {
    assert.equal(await quoteV3SwapOutRaw({ provider: {}, networkConfig: V3_NETWORK, swap: buildDraftSwap(), fee: 500 }), null);
    assert.equal(await quoteV4SwapOutRaw({ provider: {}, networkConfig: V4_NETWORK, poolKey: POOL_KEY, swap: buildDraftSwap() }), null);
  } finally {
    restore();
  }
});

test('sin quoter configurado en la red no se cotiza', async () => {
  const restore = stubQuoter(async () => { throw new Error('no deberia cotizar'); });
  try {
    const sinQuoter = { id: 'x', deployments: { v3: {}, v4: {} } };
    assert.equal(await quoteV3SwapOutRaw({ provider: {}, networkConfig: sinQuoter, swap: buildDraftSwap(), fee: 500 }), null);
    assert.equal(await quoteV4SwapOutRaw({ provider: {}, networkConfig: sinQuoter, poolKey: POOL_KEY, swap: buildDraftSwap() }), null);
  } finally {
    restore();
  }
});
