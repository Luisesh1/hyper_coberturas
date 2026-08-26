const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogNetworkSchema, adoptSchema } = require('../src/schemas/smart-contract-registry.schema');

test('catalogNetworkSchema exige una red soportada', () => {
  assert.equal(catalogNetworkSchema.safeParse({ network: 'base-sepolia' }).success, true);
  assert.equal(catalogNetworkSchema.safeParse({ network: 'solana' }).success, false);
  assert.equal(catalogNetworkSchema.safeParse({}).success, false);
});

test('adoptSchema acepta txHash opcional y valida su forma', () => {
  assert.equal(adoptSchema.safeParse({ network: 'base' }).success, true);
  assert.equal(adoptSchema.safeParse({ network: 'base', txHash: `0x${'a'.repeat(64)}` }).success, true);
  assert.equal(adoptSchema.safeParse({ network: 'base', txHash: 'no-es-un-hash' }).success, false);
});
