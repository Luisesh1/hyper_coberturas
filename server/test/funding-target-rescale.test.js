const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeAmountsFromWeight,
  resolveEffectiveFundingTargetUsd,
} = require('../src/services/smart-pool-creator.service');

test('resolveEffectiveFundingTargetUsd deja el objetivo si lo seleccionado alcanza', () => {
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 500, selectedUsd: 800 }), 500);
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 500, selectedUsd: 500 }), 500);
});

test('resolveEffectiveFundingTargetUsd baja el objetivo a lo seleccionado', () => {
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 520, selectedUsd: 492.19 }), 492.19);
});

test('resolveEffectiveFundingTargetUsd ignora una selección sin valor conocido', () => {
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 520, selectedUsd: null }), 520);
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 520, selectedUsd: 0 }), 520);
  assert.equal(resolveEffectiveFundingTargetUsd({ totalUsdTarget: 520, selectedUsd: Number.NaN }), 520);
});

// Regresión (Base, LP #3110339): objetivo $520 a 49,8/50,2 con WETH $259 y
// USDC $233 seleccionados. Con el objetivo sin reescalar, cada lado pedía
// ~$259/$261: el WETH se consumía entero en token0 y al USDC le faltaban $28
// sin nada que swapear. El plan pasaba el umbral del 93 % pero desbalanceado;
// el mint quedó en ~$456 y ~$35 de ETH volvieron a la wallet. Reescalado a lo
// seleccionado, token0 pide menos que el WETH disponible y el sobrante queda
// libre para cubrir el déficit de USDC con un swap.
test('el objetivo reescalado deja WETH sobrante para cubrir el déficit de USDC', () => {
  const ethPrice = 2695;
  const wethUsd = 0.096115802171 * ethPrice;
  const usdcUsd = 233.233963;
  const target = resolveEffectiveFundingTargetUsd({ totalUsdTarget: 520, selectedUsd: wethUsd + usdcUsd });
  const amounts = computeAmountsFromWeight(49.8, target, ethPrice, 1, 18, 6);

  const need0Usd = Number(amounts.amount0Desired) * ethPrice;
  const need1Usd = Number(amounts.amount1Desired);
  assert.ok(need0Usd < wethUsd, 'token0 debe pedir menos que el WETH disponible');
  const wethLeftoverUsd = wethUsd - need0Usd;
  const usdcDeficitUsd = need1Usd - usdcUsd;
  assert.ok(usdcDeficitUsd > 0, 'el USDC solo no alcanza para token1');
  assert.ok(Math.abs(wethLeftoverUsd - usdcDeficitUsd) < 0.05, 'el sobrante de WETH cubre el déficit de USDC');
});
