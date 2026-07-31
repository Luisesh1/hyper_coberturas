const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWrapNativeTx } = require('../../src/services/uniswap/tx-encoders');

const WETH = { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH' };

// Un QUANTITY de JSON-RPC no admite ceros a la izquierda. `ethers.toBeHex`
// alinea a bytes, asi que 1 ETH salia como `0x0de0b6b3a7640000` y Arbitrum
// Nitro rechazaba la tx entera con "invalid argument 0: json: cannot unmarshal
// hex number with leading zero digits" (-32602), que la wallet mostraba como
// "Missing or invalid parameters [codigo -32000]". Fallaba solo cuando el
// monto tenia un numero impar de digitos hex: por eso el fondeo de LP fallaba
// de forma intermitente segun el monto.
const RPC_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;

test('el value del wrap es un QUANTITY valido para el JSON-RPC', () => {
  const tx = buildWrapNativeTx(WETH, 10n ** 18n, 42161);
  assert.match(tx.value, RPC_QUANTITY);
  assert.equal(tx.value, '0xde0b6b3a7640000');
});

test('ningun monto genera ceros a la izquierda', () => {
  // Montos con largo hex impar (los que rompian) y par (los que pasaban).
  const montos = [
    1n,
    10n ** 15n,          // 0.001 ETH -> impar
    10n ** 16n,          // 0.01  ETH -> par
    5n * 10n ** 17n,     // 0.5   ETH -> impar
    123456789n,
    2n ** 96n,
  ];
  for (const monto of montos) {
    const tx = buildWrapNativeTx(WETH, monto, 42161);
    assert.match(tx.value, RPC_QUANTITY, `monto ${monto} produjo value ${tx.value}`);
    assert.equal(BigInt(tx.value), monto, 'el value debe seguir representando el monto');
  }
});

test('el monto original queda en meta para la UI', () => {
  const tx = buildWrapNativeTx(WETH, 10n ** 18n, 42161);
  assert.equal(tx.amount, (10n ** 18n).toString());
  assert.equal(tx.kind, 'wrap_native');
});

test('un monto en cero no genera tx', () => {
  assert.equal(buildWrapNativeTx(WETH, 0n, 42161), null);
});
