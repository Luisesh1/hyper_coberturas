const test = require('node:test');
const assert = require('node:assert/strict');

const hedgeServicePath = require.resolve('../src/services/hedge.service');
const hlRegistryPath = require.resolve('../src/services/hyperliquid.registry');
const tgRegistryPath = require.resolve('../src/services/telegram.registry');
const accountsServicePath = require.resolve('../src/services/hyperliquid-accounts.service');
const hedgeRegistryPath = require.resolve('../src/services/hedge.registry');

test('HedgeRegistry.reload reemplaza la instancia detenida antes de devolver', async (t) => {
  let generation = 0;

  class FakeHedgeService {
    constructor() {
      this.generation = ++generation;
      this.stopped = false;
    }

    async init() {}

    stopMonitor() {
      this.stopped = true;
    }
  }

  const replacements = new Map([
    [hedgeServicePath, FakeHedgeService],
    [hlRegistryPath, { getOrCreate: async () => ({}) }],
    [tgRegistryPath, { getOrCreate: async () => ({}) }],
    [accountsServicePath, {
      resolveAccount: async (_userId, accountId) => ({ id: Number(accountId) }),
      listAccounts: async () => [],
    }],
  ]);
  const previous = new Map();
  for (const [path, exports] of replacements) {
    previous.set(path, require.cache[path]);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  delete require.cache[hedgeRegistryPath];

  t.after(() => {
    delete require.cache[hedgeRegistryPath];
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  });

  const hedgeRegistry = require(hedgeRegistryPath);
  const first = await hedgeRegistry.getOrCreate(7, 3);
  const reloaded = await hedgeRegistry.reload(7, 3);

  assert.equal(first.generation, 1);
  assert.equal(first.stopped, true);
  assert.equal(reloaded.generation, 2);
  assert.equal(reloaded.stopped, false);
  assert.equal(hedgeRegistry.get(7, 3), reloaded);
});
