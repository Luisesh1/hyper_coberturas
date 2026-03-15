const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SETTINGS_ENCRYPTION_KEY = 'test-settings-key';

const db = require('../src/db');
const settingsRepository = require('../src/repositories/settings.repository');
const accountsRepository = require('../src/repositories/hyperliquid-account.repository');
const service = require('../src/services/hyperliquid-accounts.service');

function withPatched(object, patches) {
  const originals = {};
  for (const [key, value] of Object.entries(patches)) {
    originals[key] = object[key];
    object[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) {
      object[key] = value;
    }
  };
}

test('ensureLegacyWalletMigrated crea cuenta default y asigna hedges legacy', async () => {
  const calls = [];
  const release = withPatched(accountsRepository, {
    countByUser: async () => 0,
    create: async (_userId, payload) => {
      calls.push(['create', payload]);
      return { id: 77, user_id: 1, alias: payload.alias, address: payload.address, is_default: true, private_key_encrypted: payload.privateKeyEncrypted };
    },
    assignLegacyHedges: async (userId, accountId) => {
      calls.push(['assignLegacyHedges', userId, accountId]);
    },
  });
  const releaseSettings = withPatched(settingsRepository, {
    getByKey: async () => ({
      value: service.upsertDefaultWallet ? require('../src/services/settings.crypto').encryptJson({
        address: '0x00000000000000000000000000000000000000AA',
        privateKey: '0xabc',
      }) : null,
    }),
  });
  const releaseDb = withPatched(db.pool, {
    connect: async () => ({
      query: async () => {},
      release: () => {},
    }),
  });

  try {
    await service.ensureLegacyWalletMigrated(1);
    assert.equal(calls[0][0], 'create');
    assert.equal(calls[0][1].isDefault, true);
    assert.equal(calls[1][0], 'assignLegacyHedges');
    assert.equal(calls[1][2], 77);
  } finally {
    releaseDb();
    releaseSettings();
    release();
  }
});

test('createAccount vuelve default la primera cuenta', async () => {
  const calls = [];
  const releaseRepo = withPatched(accountsRepository, {
    countByUser: async () => 0,
    clearDefault: async () => calls.push('clearDefault'),
    create: async (_userId, payload) => ({
      id: 10,
      user_id: 1,
      alias: payload.alias,
      address: payload.address,
      is_default: payload.isDefault,
      private_key_encrypted: payload.privateKeyEncrypted,
    }),
  });
  const releaseSettings = withPatched(settingsRepository, {
    getByKey: async () => null,
  });
  const releaseDb = withPatched(db.pool, {
    connect: async () => ({
      query: async () => {},
      release: () => {},
    }),
  });

  try {
    const account = await service.createAccount(1, {
      alias: 'Principal',
      address: '0x00000000000000000000000000000000000000AA',
      privateKey: '0xabc',
      isDefault: false,
    });
    assert.equal(account.isDefault, true);
    assert.deepEqual(calls, ['clearDefault']);
  } finally {
    releaseDb();
    releaseSettings();
    releaseRepo();
  }
});

test('setDefaultAccount limpia default previo y marca la nueva cuenta', async () => {
  const calls = [];
  const releaseRepo = withPatched(accountsRepository, {
    countByUser: async () => 1,
    getById: async () => ({
      id: 9,
      user_id: 1,
      alias: 'Secundaria',
      address: '0x00000000000000000000000000000000000000BB',
      is_default: false,
      private_key_encrypted: null,
    }),
    clearDefault: async () => calls.push('clearDefault'),
    setDefault: async (_userId, accountId) => {
      calls.push(['setDefault', accountId]);
      return {
        id: accountId,
        user_id: 1,
        alias: 'Secundaria',
        address: '0x00000000000000000000000000000000000000BB',
        is_default: true,
        private_key_encrypted: null,
      };
    },
  });
  const releaseDb = withPatched(db.pool, {
    connect: async () => ({
      query: async () => {},
      release: () => {},
    }),
  });

  try {
    const account = await service.setDefaultAccount(1, 9);
    assert.equal(account.isDefault, true);
    assert.deepEqual(calls, ['clearDefault', ['setDefault', 9]]);
  } finally {
    releaseDb();
    releaseRepo();
  }
});

test('deleteAccount promociona otra cuenta cuando se elimina la default', async () => {
  const calls = [];
  const releaseRepo = withPatched(accountsRepository, {
    countByUser: async () => 2,
    getById: async () => ({
      id: 1,
      user_id: 1,
      alias: 'Principal',
      address: '0x00000000000000000000000000000000000000AA',
      is_default: true,
      private_key_encrypted: null,
    }),
    countHedgesByAccount: async () => 0,
    deleteById: async () => ({
      id: 1,
      user_id: 1,
      alias: 'Principal',
      address: '0x00000000000000000000000000000000000000AA',
      is_default: true,
      private_key_encrypted: null,
    }),
    listByUser: async () => [{
      id: 2,
      user_id: 1,
      alias: 'Backup',
      address: '0x00000000000000000000000000000000000000BB',
      is_default: false,
      private_key_encrypted: null,
    }],
    clearDefault: async () => calls.push('clearDefault'),
    setDefault: async (_userId, accountId) => calls.push(['setDefault', accountId]),
  });
  const releaseDb = withPatched(db.pool, {
    connect: async () => ({
      query: async () => {},
      release: () => {},
    }),
  });

  try {
    await service.deleteAccount(1, 1);
    assert.deepEqual(calls, ['clearDefault', ['setDefault', 2]]);
  } finally {
    releaseDb();
    releaseRepo();
  }
});
