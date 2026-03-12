const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SETTINGS_ENCRYPTION_KEY = 'test-settings-key';

const {
  ENCRYPTED_PREFIX,
  decryptValue,
  encryptJson,
} = require('../src/services/settings.service');

test('encryptJson cifra payload sensible', () => {
  const encrypted = encryptJson({ privateKey: '0xabc', address: '0x123' });

  assert.ok(encrypted.startsWith(ENCRYPTED_PREFIX));
  assert.notEqual(encrypted.includes('0xabc'), true);
});

test('decryptValue soporta payload cifrado', () => {
  const input = { token: 'abc', chatId: '123' };
  const encrypted = encryptJson(input);

  assert.deepEqual(decryptValue(encrypted), input);
});

test('decryptValue mantiene compatibilidad con JSON plano legado', () => {
  const plain = JSON.stringify({ address: '0xlegacy' });
  assert.deepEqual(decryptValue(plain), { address: '0xlegacy' });
});
