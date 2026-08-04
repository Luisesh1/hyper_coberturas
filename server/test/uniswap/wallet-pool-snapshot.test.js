const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWalletPoolSnapshot } = require('../../src/services/uniswap/actions/helpers');

function makeScanner(responses) {
  let call = 0;
  const scanner = {
    calls: 0,
    async scanPoolsCreatedByWallet() {
      scanner.calls += 1;
      const pools = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { pools };
    },
  };
  return scanner;
}

const noSleep = async () => {};

test('devuelve el snapshot cuando el scan encuentra la posicion', async () => {
  const snapshot = { identifier: '191720', mode: 'lp_position', version: 'v4' };
  const scanner = makeScanner([[snapshot]]);

  const result = await loadWalletPoolSnapshot(3, {
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xabc',
    positionIdentifier: '191720',
    scanner,
    sleep: noSleep,
  });

  assert.equal(result, snapshot);
  assert.equal(scanner.calls, 1);
});

test('reintenta cuando la posicion recien minteada aun no aparece', async () => {
  const snapshot = { identifier: '191720', mode: 'lp_position', version: 'v4' };
  const scanner = makeScanner([[], [], [snapshot]]);

  const result = await loadWalletPoolSnapshot(3, {
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xabc',
    positionIdentifier: '191720',
    attempts: 3,
    scanner,
    sleep: noSleep,
  });

  assert.equal(result, snapshot);
  assert.equal(scanner.calls, 3);
});

test('lanza SNAPSHOT_NOT_FOUND en vez de devolver null tras agotar intentos', async () => {
  const scanner = makeScanner([[]]);

  await assert.rejects(
    () => loadWalletPoolSnapshot(3, {
      network: 'arbitrum',
      version: 'v4',
      walletAddress: '0xabc',
      positionIdentifier: '191720',
      attempts: 2,
      scanner,
      sleep: noSleep,
    }),
    (err) => {
      assert.equal(err.code, 'SNAPSHOT_NOT_FOUND');
      assert.match(err.message, /191720/);
      return true;
    }
  );
  assert.equal(scanner.calls, 2);
});
