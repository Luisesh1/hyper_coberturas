const test = require('node:test');
const assert = require('node:assert/strict');

const { computeSideDeficits, deliveryTokenFor } = require('../src/services/cross-chain/side-deficits');

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';

const TOKEN0 = { address: WETH, symbol: 'WETH', decimals: 18 };
const TOKEN1 = { address: USDC, symbol: 'USDC', decimals: 6 };

test('con lo local por encima del 93 % no hace falta cross-chain', () => {
  const result = computeSideDeficits({
    targetUsd: 1000, weightToken0Pct: 50, token0: TOKEN0, token1: TOKEN1, wrappedNativeAddress: WETH,
    localAssets: [{ address: USDC, usableUsd: 600 }, { address: ZERO, isNative: true, usableUsd: 340 }],
  });
  assert.equal(result.needsCrossChain, false);
  assert.equal(result.totalDeficitUsd, 0);
  assert.deepEqual(result.deficitUsd, { token0: 0, token1: 0 });
});

test('el déficit de cada lado es lo que le falta con el colchón del 5 %', () => {
  const result = computeSideDeficits({
    targetUsd: 1000, weightToken0Pct: 50, token0: TOKEN0, token1: TOKEN1, wrappedNativeAddress: WETH,
    localAssets: [{ address: USDC, usableUsd: 180 }],
  });
  assert.equal(result.needsCrossChain, true);
  assert.equal(result.needUsd.token0, 525);
  assert.equal(result.haveUsd.token1, 180);
  assert.ok(Math.abs(result.deficitUsd.token0 - 525) < 1e-9);
  assert.ok(Math.abs(result.deficitUsd.token1 - 345) < 1e-9);
  assert.ok(Math.abs(result.totalDeficitUsd - 870) < 1e-9);
});

test('los activos locales no directos se descuentan en proporción a lo que falta', () => {
  const result = computeSideDeficits({
    targetUsd: 1000, weightToken0Pct: 50, token0: TOKEN0, token1: TOKEN1, wrappedNativeAddress: WETH,
    localAssets: [{ address: USDC, usableUsd: 180 }, { address: DAI, usableUsd: 300 }],
  });
  assert.equal(result.otherLocalUsd, 300);
  // faltan 870 − 300 = 570, repartidos 525:345
  assert.ok(Math.abs(result.totalDeficitUsd - 570) < 1e-9);
  assert.ok(Math.abs(result.deficitUsd.token0 - (570 * 525) / 870) < 1e-9);
  assert.ok(Math.abs(result.deficitUsd.token1 - (570 * 345) / 870) < 1e-9);
});

test('el nativo cuenta como el lado WETH y como el lado address(0)', () => {
  const wethPool = computeSideDeficits({
    targetUsd: 100, weightToken0Pct: 50, token0: TOKEN0, token1: TOKEN1, wrappedNativeAddress: WETH,
    localAssets: [{ address: ZERO, isNative: true, usableUsd: 40 }],
  });
  assert.equal(wethPool.haveUsd.token0, 40);
  const nativePool = computeSideDeficits({
    targetUsd: 100, weightToken0Pct: 50, token0: { address: ZERO, symbol: 'ETH', decimals: 18 }, token1: TOKEN1,
    wrappedNativeAddress: WETH,
    localAssets: [{ address: WETH, usableUsd: 30 }, { address: ZERO, isNative: true, usableUsd: 10 }],
  });
  assert.equal(nativePool.haveUsd.token0, 40);
});

test('los activos sin valor usable no cuentan', () => {
  const result = computeSideDeficits({
    targetUsd: 100, weightToken0Pct: 50, token0: TOKEN0, token1: TOKEN1, wrappedNativeAddress: WETH,
    localAssets: [{ address: DAI, usableUsd: null }, { address: USDC, usableUsd: 0 }],
  });
  assert.equal(result.localUsableUsd, 0);
});

test('se entrega el nativo cuando el lado es WETH o address(0); si no, el token', () => {
  assert.deepEqual(deliveryTokenFor(TOKEN0, { wrappedNativeAddress: WETH, nativeSymbol: 'ETH' }), {
    address: ZERO, symbol: 'ETH', decimals: 18, isNative: true,
  });
  assert.deepEqual(deliveryTokenFor(TOKEN1, { wrappedNativeAddress: WETH, nativeSymbol: 'ETH' }), {
    address: USDC, symbol: 'USDC', decimals: 6, isNative: false,
  });
});
