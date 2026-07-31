const test = require('node:test');
const assert = require('node:assert/strict');

const { assertTxPlanShape, buildRawTxParams } = require('../../src/scripts/e2e-testnet-flow');

const VALID_TO = '0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80';
const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

function tx(overrides = {}) {
  return { to: VALID_TO, data: '0xd0e30db0', value: '0x0', kind: 'wrap_native', ...overrides };
}

test('acepta un plan bien formado', () => {
  assert.doesNotThrow(() => assertTxPlanShape(tx({ value: '0xde0b6b3a7640000' }), 'wrap'));
});

// El guardarrail que hace que el harness sirva para algo: sin el, un value con
// cero a la izquierda solo se manifiesta como "Missing or invalid parameters
// [codigo -32000]" en la wallet del usuario, sin decir que tx ni que campo.
test('rechaza un value con ceros a la izquierda y explica por que', () => {
  assert.throws(
    () => assertTxPlanShape(tx({ value: '0x0de0b6b3a7640000' }), 'wrap'),
    (err) => {
      assert.match(err.message, /QUANTITY/);
      assert.match(err.message, /toQuantity/);
      assert.match(err.message, /wrap/);
      return true;
    }
  );
});

test('rechaza gas con ceros a la izquierda', () => {
  assert.throws(() => assertTxPlanShape(tx({ gas: '0x05208' }), 'mint'), /QUANTITY/);
});

test('rechaza destino y calldata invalidos', () => {
  assert.throws(() => assertTxPlanShape(tx({ to: undefined }), 'mint'), /destino invalido/);
  assert.throws(() => assertTxPlanShape(tx({ data: '0xabc' }), 'mint'), /calldata invalida/);
});

// Un envio de ETH puro no lleva calldata: no hay que rechazarlo.
test('acepta un envio de valor sin calldata', () => {
  assert.doesNotThrow(() => assertTxPlanShape({ to: VALID_TO, value: '0x1' }, 'send'));
});

test('los params crudos replican los del cliente', () => {
  const params = buildRawTxParams(tx({ value: '0x1', gasEstimate: '0x5208' }), WALLET);
  assert.deepEqual(params, {
    from: WALLET,
    to: VALID_TO,
    data: '0xd0e30db0',
    value: '0x1',
    gas: '0x5208',
  });
});
