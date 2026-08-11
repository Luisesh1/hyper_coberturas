const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateLiquidityForAmounts,
  priceToNearestTick,
} = require('../src/services/uniswap/position-math');

// Regresion: `position-math` importaba tickToRawSqrtRatio desde
// `domains/uniswap/pools/domain/position-action-math`, que NO lo exporta. El
// destructuring daba `undefined` y el primer mint v4 real reventaba con
// "tickToRawSqrtRatio is not a function" (500 en create-position/prepare).
// El bug quedo latente desde el refactor 290e1f8 porque
// estimateLiquidityForAmounts solo se usa en el camino v4.
test('estimateLiquidityForAmounts devuelve liquidez con el precio dentro del rango', () => {
  const liquidity = estimateLiquidityForAmounts({
    amount0Raw: 10n ** 18n,
    amount1Raw: 3000n * 10n ** 6n,
    tickCurrent: 0,
    tickLower: -600,
    tickUpper: 600,
  });
  assert.equal(typeof liquidity, 'bigint');
  assert.ok(liquidity > 0n, `liquidez debe ser positiva, fue ${liquidity}`);
});

// Regresion del ETH/USDC 0.30% que fallaba al crear un orquestador. El pool
// estaba en el tick -200967, pero su sqrtPriceX96 exacto estaba avanzado dentro
// de ese tick. Reconstruir sqrt(current) desde el tick inflaba la liquidez un
// 0.55% y el PositionManager terminaba pidiendo 52.604306 USDC contra un maximo
// de 52.573560 (MaximumAmountExceeded).
test('usa sqrtPriceX96 exacto para no inflar la liquidez dentro del tick activo', () => {
  const args = {
    amount0Raw: 27_595632791000000n,
    amount1Raw: 52_312000n,
    tickCurrent: -200967,
    tickLower: -201120,
    tickUpper: -200820,
  };
  const desdeTickEntero = estimateLiquidityForAmounts(args);
  const desdeSqrtExacto = estimateLiquidityForAmounts({
    ...args,
    sqrtPriceX96: '3429045923241452434882560',
  });

  assert.equal(desdeTickEntero, 158_615787626032n);
  assert.equal(desdeSqrtExacto, 157_734408893455n);
  assert.ok(desdeSqrtExacto < desdeTickEntero, 'el tick entero sobreestimaba la liquidez');
  assert.ok(
    ((desdeTickEntero - desdeSqrtExacto) * 10_000n) / desdeTickEntero > 50n,
    'la desviacion real superaba el slippage por defecto de 50 bps'
  );
});

test('estimateLiquidityForAmounts soporta el precio por debajo y por encima del rango', () => {
  const below = estimateLiquidityForAmounts({
    amount0Raw: 10n ** 18n,
    amount1Raw: 0n,
    tickCurrent: -1200,
    tickLower: -600,
    tickUpper: 600,
  });
  const above = estimateLiquidityForAmounts({
    amount0Raw: 0n,
    amount1Raw: 3000n * 10n ** 6n,
    tickCurrent: 1200,
    tickLower: -600,
    tickUpper: 600,
  });
  // Fuera de rango la posicion es de un solo lado, pero sigue teniendo L > 0.
  assert.ok(below > 0n, `below=${below}`);
  assert.ok(above > 0n, `above=${above}`);
});

test('priceToNearestTick respeta el tickSpacing y la direccion', () => {
  const spacing = 60;
  // WETH/USDC (18 vs 6 decimales) da ticks negativos; el modulo puede valer
  // -0, que assert.equal estricto distingue de 0 — de ahi el Math.abs.
  const down = priceToNearestTick(3000, 18, 6, spacing, 'down');
  const up = priceToNearestTick(3000, 18, 6, spacing, 'up');
  assert.equal(Math.abs(down % spacing), 0, 'el tick debe caer en la grilla del spacing');
  assert.equal(Math.abs(up % spacing), 0);
  assert.ok(up >= down, `up=${up} debe ser >= down=${down}`);
  assert.ok(up - down <= spacing, 'down y up deben ser ticks contiguos de la grilla');
});
