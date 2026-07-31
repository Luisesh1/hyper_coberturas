const test = require('node:test');
const assert = require('node:assert/strict');

const { applyMintSlippageCeiling } = require('../src/services/uniswap/actions/prepare-v4');
const { DEFAULT_SLIPPAGE_BPS } = require('../src/services/uniswap/constants');

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
