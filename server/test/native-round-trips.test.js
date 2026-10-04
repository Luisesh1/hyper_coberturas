const test = require('node:test');
const assert = require('node:assert/strict');
const { planNativeRoundTrips } = require('../src/services/uniswap/actions/helpers');

const WETH = '0x7943e237c7F95DA44E0301572D358911207852Fa';
const native = (raw) => ({ isNative: true, address: '0x0000000000000000000000000000000000000000', fundingRole: 'direct_token0', useAmountRaw: String(raw) });
const wrapped = (raw) => ({ isNative: false, address: WETH, fundingRole: 'direct_token0', useAmountRaw: String(raw) });
const swapFromNative = (raw) => ({ requiresWrapNative: true, wrapToken: { address: WETH }, amountInRaw: String(raw) });

// Plan real de la prueba en Robinhood (2026-10-03): wrap del ETH directo,
// wrap del ETH que se swapea y unwrap de todo el lado nativo. Tres firmas que
// se anulan entre sí.
test('el ETH directo y el ETH a swapear no se envuelven si el lado nativo ya tiene WETH', () => {
  const result = planNativeRoundTrips({
    selectedFundingAssets: [wrapped(3036), native(900)],
    swapPlan: [swapFromNative(2000)],
    plannedUnwrapRaw: 3936n,
    wrappedNativeAddress: WETH,
  });

  assert.equal(result.netWrapRaw, 0n);
  // El swap gasta 2000 del WETH que se iba a desenvolver; el ETH queda nativo.
  assert.equal(result.swapPlan[0].requiresWrapNative, false);
  assert.equal(result.netUnwrapRaw, 1036n);
});

test('con poco WETH, el swap solo envuelve lo que falta', () => {
  const result = planNativeRoundTrips({
    selectedFundingAssets: [wrapped(500)],
    swapPlan: [swapFromNative(2000)],
    plannedUnwrapRaw: 500n,
    wrappedNativeAddress: WETH,
  });

  assert.equal(result.swapPlan[0].requiresWrapNative, true);
  assert.equal(result.swapPlan[0].wrapAmountRaw, '1500');
  assert.equal(result.netUnwrapRaw, 0n);
});

test('sin lado nativo en el pool no compensa nada', () => {
  const result = planNativeRoundTrips({
    selectedFundingAssets: [native(900), wrapped(1000)],
    swapPlan: [swapFromNative(2000)],
    plannedUnwrapRaw: 0n,
    wrappedNativeAddress: WETH,
  });

  assert.equal(result.netWrapRaw, 900n);
  assert.equal(result.swapPlan[0].requiresWrapNative, true);
  assert.equal(result.swapPlan[0].wrapAmountRaw, undefined);
  assert.equal(result.netUnwrapRaw, 0n);
});

test('el ETH directo se compensa aunque no haya WETH para los swaps', () => {
  const result = planNativeRoundTrips({
    selectedFundingAssets: [native(900)],
    swapPlan: [swapFromNative(2000)],
    plannedUnwrapRaw: 2900n,
    wrappedNativeAddress: WETH,
  });

  assert.equal(result.netWrapRaw, 0n);
  assert.equal(result.swapPlan[0].requiresWrapNative, true);
  assert.equal(result.netUnwrapRaw, 2000n);
});

test('el saldo final de ETH nativo es el mismo que con el viaje completo', () => {
  const assets = [wrapped(3036), native(900)];
  const swaps = [swapFromNative(2000)];
  const unwrap = 3936n;
  const r = planNativeRoundTrips({ selectedFundingAssets: assets, swapPlan: swaps, plannedUnwrapRaw: unwrap, wrappedNativeAddress: WETH });
  // Nativo que gasta el plan: lo envuelto (directo + swaps) menos lo desenvuelto.
  const wrapsOf = (plan) => plan.reduce((sum, s) => sum + (s.requiresWrapNative ? BigInt(s.wrapAmountRaw ?? s.amountInRaw) : 0n), 0n);
  const nativeSpentNaive = 900n + 2000n - unwrap;
  const nativeSpentNetted = r.netWrapRaw + wrapsOf(r.swapPlan) - r.netUnwrapRaw;
  assert.equal(nativeSpentNetted, nativeSpentNaive);
});
