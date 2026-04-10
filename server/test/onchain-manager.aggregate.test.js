const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OnChainManager,
  MULTICALL3_ADDRESS,
  MULTICALL3_ABI,
} = require('../src/services/onchain-manager.service');

test('OnChainManager: telemetría acumula counts y duraciones por (scope, method)', async () => {
  const mgr = new OnChainManager();

  // Simulamos 3 llamadas exitosas + 1 error en el mismo (scope, method).
  await mgr._track('test-scope', 'fakeCall', async () => 'ok');
  await mgr._track('test-scope', 'fakeCall', async () => 'ok');
  await mgr._track('test-scope', 'fakeCall', async () => 'ok');
  await assert.rejects(
    mgr._track('test-scope', 'fakeCall', async () => { throw new Error('boom'); }),
    /boom/
  );

  const stats = mgr.getStats();
  assert.equal(stats['test-scope'].fakeCall.count, 4);
  assert.equal(stats['test-scope'].fakeCall.errors, 1);
  assert.ok(stats['test-scope'].fakeCall.avgMs >= 0);
  assert.ok(stats['test-scope'].fakeCall.p50Ms >= 0);
  assert.ok(stats['test-scope'].fakeCall.p99Ms >= 0);
});

test('OnChainManager: resetStats limpia el snapshot', async () => {
  const mgr = new OnChainManager();
  await mgr._track('s', 'm', async () => 'ok');
  assert.equal(mgr.getStats().s.m.count, 1);

  mgr.resetStats();
  assert.deepEqual(mgr.getStats(), {});
});

test('OnChainManager: percentiles con un solo sample', async () => {
  const mgr = new OnChainManager();
  await mgr._track('s', 'm', async () => 'ok');
  const stats = mgr.getStats();
  assert.equal(stats.s.m.p50Ms, stats.s.m.avgMs);
  assert.equal(stats.s.m.p99Ms, stats.s.m.avgMs);
});

test('OnChainManager: ring buffer no crece sin límite', async () => {
  const mgr = new OnChainManager();
  // Disparamos 250 llamadas — el ring buffer debería estar cap a 200.
  for (let i = 0; i < 250; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await mgr._track('s', 'm', async () => 'ok');
  }
  const scopeMap = mgr.metrics.get('s');
  assert.equal(scopeMap.get('m').samples.length, 200);
  assert.equal(scopeMap.get('m').count, 250); // count NO se cap
});

test('OnChainManager.aggregate: vacío devuelve []', async () => {
  const mgr = new OnChainManager();
  const result = await mgr.aggregate({ networkConfig: null, calls: [] });
  assert.deepEqual(result, []);
});

test('OnChainManager.aggregate: encodea y decodea via stub Multicall3', async () => {
  const { ethers } = require('ethers');
  const mgr = new OnChainManager();

  // Stub del provider que intercepta `getProvider` y devuelve un mock que
  // pretende ser Multicall3. Replica `aggregate3.staticCall` con el mismo
  // shape de entrada/salida que ethers v6 espera.
  const FAKE_BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)'];
  const ifaceFake = new ethers.Interface(FAKE_BALANCE_OF_ABI);
  const ifaceMc = new ethers.Interface(MULTICALL3_ABI);
  const FAKE_TOKEN = '0x0000000000000000000000000000000000000123';
  const FAKE_WALLET = '0x0000000000000000000000000000000000000456';

  // Inyectamos el provider en el cache directamente.
  const fakeProvider = {
    call: async ({ data }) => {
      // Decodeamos el llamado al multicall3 para validar que el encoding es correcto.
      const decoded = ifaceMc.decodeFunctionData('aggregate3', data);
      const calls = decoded[0];
      const returnData = calls.map((c) => {
        // Cada call debe ser balanceOf(FAKE_WALLET) → devolvemos 42n encodeado.
        const fnData = c[2];
        const inner = ifaceFake.decodeFunctionData('balanceOf', fnData);
        assert.equal(inner[0].toLowerCase(), FAKE_WALLET.toLowerCase());
        return [true, ifaceFake.encodeFunctionResult('balanceOf', [42n])];
      });
      return ifaceMc.encodeFunctionResult('aggregate3', [returnData]);
    },
    estimateGas: async () => 0n,
    getBalance: async () => 0n,
  };

  // Hack: inyectamos el provider en el cache para que getProvider lo devuelva.
  const networkConfig = { id: 'fake', chainId: 99999, rpcUrl: 'http://fake' };
  const cacheKey = mgr.getProviderCacheKey(networkConfig, 'test');
  mgr.providerCache.set(cacheKey, fakeProvider);

  const result = await mgr.aggregate({
    networkConfig,
    scope: 'test',
    calls: [
      { target: FAKE_TOKEN, abi: FAKE_BALANCE_OF_ABI, method: 'balanceOf', args: [FAKE_WALLET] },
      { target: FAKE_TOKEN, abi: FAKE_BALANCE_OF_ABI, method: 'balanceOf', args: [FAKE_WALLET] },
    ],
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].success, true);
  assert.equal(result[0].value, 42n);
  assert.equal(result[1].success, true);
  assert.equal(result[1].value, 42n);

  // El _track del scope 'test' debe haber acumulado 1 aggregate3.
  const stats = mgr.getStats();
  assert.equal(stats.test.aggregate3.count, 1);
  assert.equal(stats.test.aggregate3.errors, 0);
});

test('OnChainManager exports: MULTICALL3_ADDRESS y MULTICALL3_ABI', () => {
  assert.equal(MULTICALL3_ADDRESS, '0xcA11bde05977b3631167028862bE2a173976CA11');
  assert.ok(Array.isArray(MULTICALL3_ABI));
  assert.ok(MULTICALL3_ABI.some((s) => typeof s === 'string' && s.includes('aggregate3')));
});
