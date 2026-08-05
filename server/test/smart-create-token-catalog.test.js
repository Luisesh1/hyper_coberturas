const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { getKnownTokens } = require('../src/services/smart-pool-creator.service');

const ZERO = ethers.ZeroAddress;

/**
 * En v4 el ETH es una currency de primera clase (address(0)). Ofrecer WETH
 * junto a el parte la liquidez y obliga a un wrap que el pool no necesita, asi
 * que el catalogo de v4 sustituye el envuelto por el nativo.
 */
test('v4 ofrece el nativo en lugar del envuelto', () => {
  const tokens = getKnownTokens('arbitrum', { version: 'v4' });
  const symbols = tokens.map((t) => t.symbol);

  assert.ok(!symbols.includes('WETH'), 'WETH no debe aparecer en el catalogo v4');
  assert.ok(symbols.includes('ETH'), 'debe ofrecerse el nativo');

  const eth = tokens.find((t) => t.symbol === 'ETH');
  assert.equal(eth.address, ZERO, 'el nativo de v4 es address(0)');
  assert.equal(eth.decimals, 18);
  assert.equal(eth.isNative, true);
});

test('v3 mantiene el envuelto: no tiene forma de liquidar el nativo', () => {
  const tokens = getKnownTokens('arbitrum', { version: 'v3' });
  const symbols = tokens.map((t) => t.symbol);

  assert.ok(symbols.includes('WETH'));
  assert.ok(!symbols.includes('ETH'));
});

test('sin version se comporta como v3 (los callers internos dependen de eso)', () => {
  // getWrappedNativeTokenForNetwork y el planificador de fondeo llaman sin
  // version y NECESITAN el WETH para envolver/desenvolver.
  const tokens = getKnownTokens('arbitrum');
  assert.ok(tokens.some((t) => t.isWrappedNative), 'el envuelto debe seguir estando');
  assert.deepEqual(tokens, getKnownTokens('arbitrum', { version: 'v3' }));
});

test('el resto del catalogo no se toca', () => {
  const v3 = getKnownTokens('arbitrum', { version: 'v3' });
  const v4 = getKnownTokens('arbitrum', { version: 'v4' });

  assert.equal(v4.length, v3.length, 'solo se sustituye una entrada, no se agrega ni se quita');
  const sinNativo = (list) => list.filter((t) => !t.isWrappedNative && !t.isNative);
  assert.deepEqual(sinNativo(v4), sinNativo(v3));
});

test('el simbolo del nativo sale de la red, no esta hardcodeado', () => {
  // Polygon usa POL: ofrecer "ETH" ahi seria mentir sobre el activo.
  const polygon = getKnownTokens('polygon', { version: 'v4' });
  const nativo = polygon.find((t) => t.isNative);
  assert.ok(nativo, 'polygon tambien sustituye su envuelto');
  assert.equal(nativo.address, ZERO);
  assert.ok(!polygon.some((t) => t.symbol === 'WPOL'), 'el envuelto de polygon desaparece');
  assert.notEqual(nativo.symbol, 'WPOL');
});

test('una red sin envuelto en el catalogo no se rompe', () => {
  const tokens = getKnownTokens('base-sepolia', { version: 'v4' });
  assert.ok(Array.isArray(tokens) && tokens.length > 0);
});
