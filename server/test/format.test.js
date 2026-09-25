const test = require('node:test');
const assert = require('node:assert/strict');

const { formatSize } = require('../src/utils/format');

// Regresion: con `szDecimals = 0` el formateo terminaba en punto ("12.").
// Hyperliquid tiene perps con 0 decimales de tamano y ese no es un numero
// canonico para el wire protocol.
test('formatSize sin decimales devuelve un entero sin punto final', () => {
  assert.equal(formatSize(12.7, 0), '12');
  assert.equal(formatSize(12, 0), '12');
  assert.equal(formatSize(0.4, 0), '0');
  assert.equal(formatSize(0, 0), '0');
});

test('formatSize trunca (no redondea) a los decimales del activo', () => {
  assert.equal(formatSize(1.23456, 4), '1.2345');
  assert.equal(formatSize(0.00771, 5), '0.00771');
  assert.equal(formatSize(2, 3), '2.000');
  assert.equal(formatSize(0.99999, 2), '0.99');
});

test('formatSize devuelve cero con los decimales pedidos si el tamano no es valido', () => {
  assert.equal(formatSize(-1, 2), '0.00');
  assert.equal(formatSize('abc', 3), '0.000');
});
