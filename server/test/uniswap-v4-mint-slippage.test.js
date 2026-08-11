const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyMintSlippageCeiling,
  assertV4MintAmountCeilings,
  decodeMaximumAmountExceeded,
} = require('../src/services/uniswap/actions/prepare-v4');
const { DEFAULT_SLIPPAGE_BPS } = require('../src/services/uniswap/constants');
const { ethers } = require('ethers');

// Regresion de un fallo real en Arbitrum: el mint v4 pasaba
// `amount1Max = amount1Desired` (50.500000 USDC) y el PositionManager
// requeria 50.699231, revirtiendo con
// MaximumAmountExceeded(50500000, 50699231). El wallet solo mostraba
// "Missing or invalid parameters [codigo -32000]", sin decir que era un
// revert de slippage.
test('el tope de gasto queda por encima del monto deseado', () => {
  const deseado = 50_500000n; // 50.5 USDC
  const tope = applyMintSlippageCeiling(deseado, 50); // 0.5%
  assert.ok(tope > deseado, 'sin margen cualquier redondeo hacia arriba revierte');
  assert.equal(tope, 50_752500n); // 50.5 * 1.005
  // El caso real requeria 50.699231: con el margen entra.
  assert.ok(tope >= 50_699231n, `el tope ${tope} debe cubrir el requerido real`);
});

test('el margen escala con los bps pedidos', () => {
  const deseado = 1_000_000n;
  assert.equal(applyMintSlippageCeiling(deseado, 100), 1_010_000n); // 1%
  assert.equal(applyMintSlippageCeiling(deseado, 10), 1_001_000n);  // 0.1%
});

test('cae al slippage por defecto si no se especifica o es invalido', () => {
  const deseado = 1_000_000n;
  const esperado = deseado + (deseado * BigInt(DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  assert.equal(applyMintSlippageCeiling(deseado, undefined), esperado);
  assert.equal(applyMintSlippageCeiling(deseado, 0), esperado);
  assert.equal(applyMintSlippageCeiling(deseado, NaN), esperado);
});

test('un monto en cero se queda en cero (posicion de un solo lado)', () => {
  // Fuera de rango uno de los dos lados va en 0: no hay que inflarlo.
  assert.equal(applyMintSlippageCeiling(0n, 50), 0n);
});

test('decodifica MaximumAmountExceeded aunque venga anidado por el RPC', () => {
  const data = ethers.concat([
    ethers.id('MaximumAmountExceeded(uint128,uint128)').slice(0, 10),
    ethers.AbiCoder.defaultAbiCoder().encode(['uint128', 'uint128'], [52_573560n, 52_604306n]),
  ]);
  assert.deepEqual(
    decodeMaximumAmountExceeded({ info: { error: { data } } }),
    { maximumAmount: 52_573560n, amountRequested: 52_604306n }
  );
});

test('la simulacion traduce el techo insuficiente antes de pedir firmas', async () => {
  const data = ethers.concat([
    ethers.id('MaximumAmountExceeded(uint128,uint128)').slice(0, 10),
    ethers.AbiCoder.defaultAbiCoder().encode(['uint128', 'uint128'], [52_573560n, 52_604306n]),
  ]);
  const rpcError = new Error('execution reverted');
  rpcError.info = { error: { data } };
  const provider = { call: async () => { throw rpcError; } };

  await assert.rejects(
    assertV4MintAmountCeilings({
      provider,
      tx: { to: '0x0000000000000000000000000000000000000001', data: '0x12', value: '0x0' },
      walletAddress: '0x0000000000000000000000000000000000000002',
      token0: { symbol: 'ETH', decimals: 18 },
      token1: { symbol: 'USDC', decimals: 6 },
      amount0Max: 1n,
      amount1Max: 52_573560n,
    }),
    /requiere 52\.604306 USDC.*maximo preparado de 52\.57356 USDC/
  );
});

test('la simulacion no bloquea reverts causados por approvals pendientes del plan', async () => {
  const provider = { call: async () => { throw new Error('TRANSFER_FROM_FAILED'); } };
  const result = await assertV4MintAmountCeilings({
    provider,
    tx: { to: '0x0000000000000000000000000000000000000001', data: '0x12', value: '0x0' },
    walletAddress: '0x0000000000000000000000000000000000000002',
    token0: { symbol: 'ETH', decimals: 18 },
    token1: { symbol: 'USDC', decimals: 6 },
    amount0Max: 1n,
    amount1Max: 2n,
  });
  assert.deepEqual(result, { simulated: false, skippedReason: 'state_dependencies' });
});
