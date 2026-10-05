const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReinvestLiquidityHaircut } = require('../src/services/uniswap/actions/prepare-v4');
const { estimateLiquidityForAmounts } = require('../src/services/uniswap/position-math');
const { DEFAULT_SLIPPAGE_BPS } = require('../src/services/uniswap/constants');

const sqrtAtTick = (tick) => Math.sqrt(1.0001 ** tick);

// Montos que pide el pool para `liquidity` con el precio en `sqrtP`.
function requiredAmounts(liquidity, sqrtP, tickLower, tickUpper) {
  const L = Number(liquidity);
  const lower = sqrtAtTick(tickLower);
  const upper = sqrtAtTick(tickUpper);
  return {
    amount0: L * (upper - sqrtP) / (sqrtP * upper),
    amount1: L * (sqrtP - lower),
  };
}

// Regresion del orquestador #57 (ETH/USDC 0.3% v4 en Arbitrum, rango
// ~2550-2790): reinvertir 0.003784 ETH + 10.378 USDC revertia con
// MaximumAmountExceeded porque la liquidez salia de las fees exactas y el
// tope de INCREASE_LIQUIDITY eran esas mismas fees.
test('con el recorte, lo que pide el pool cabe en las fees aunque el precio se mueva', () => {
  // ETH (18) / USDC (6): precio raw = 2700 * 1e-12
  const tickLower = Math.round(Math.log(2550e-12) / Math.log(1.0001) / 60) * 60;
  const tickUpper = Math.round(Math.log(2790e-12) / Math.log(1.0001) / 60) * 60;
  const sqrtP = Math.sqrt(2700e-12);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtP * 2 ** 96));
  const fees0 = 3_784_000_000_000_000n;
  const fees1 = 10_378_000n;

  const exact = estimateLiquidityForAmounts({
    amount0Raw: fees0, amount1Raw: fees1, tickCurrent: 0, sqrtPriceX96, tickLower, tickUpper,
  });
  const recortada = applyReinvestLiquidityHaircut(exact, 100);

  // El lado limitante es USDC: con la liquidez exacta basta que el precio
  // suba un 0.05% para pedir mas USDC del cobrado.
  const subida = requiredAmounts(exact, sqrtP * Math.sqrt(1.0005), tickLower, tickUpper);
  assert.ok(subida.amount1 > Number(fees1), 'sin recorte el USDC requerido excede las fees (el bug)');

  // Con la recortada, un 0.05% en cualquier sentido cabe en ambos lados.
  for (const move of [1.0005, 1 / 1.0005]) {
    const sqrtMoved = sqrtP * Math.sqrt(move);
    const conRecorte = requiredAmounts(recortada, sqrtMoved, tickLower, tickUpper);
    assert.ok(conRecorte.amount0 <= Number(fees0), `ETH requerido ${conRecorte.amount0} > fees`);
    assert.ok(conRecorte.amount1 <= Number(fees1), `USDC requerido ${conRecorte.amount1} > fees`);
  }
});

test('el recorte escala con los bps pedidos', () => {
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, 100), 990_000n);
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, 10), 999_000n);
});

test('cae al slippage por defecto si no se especifica o es invalido', () => {
  const esperado = (1_000_000n * (10_000n - BigInt(DEFAULT_SLIPPAGE_BPS))) / 10_000n;
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, undefined), esperado);
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, 0), esperado);
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, NaN), esperado);
});

test('nunca deja la liquidez negativa ni en cero por bps absurdos', () => {
  assert.equal(applyReinvestLiquidityHaircut(1_000_000n, 50_000), 100n);
  assert.equal(applyReinvestLiquidityHaircut(0n, 100), 0n);
});
