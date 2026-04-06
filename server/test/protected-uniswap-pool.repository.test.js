const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/protected-uniswap-pool.repository');

function buildRecord() {
  return {
    userId: 1,
    accountId: 2,
    network: 'ethereum',
    version: 'v3',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    positionIdentifier: '123',
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    token0Address: '0x00000000000000000000000000000000000000CC',
    token1Address: '0x00000000000000000000000000000000000000DD',
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: 2500,
    inferredAsset: 'ETH',
    hedgeSize: 0.5,
    hedgeNotionalUsd: 1250,
    configuredHedgeNotionalUsd: 1250,
    initialConfiguredHedgeNotionalUsd: 1250,
    valueMultiplier: null,
    stopLossDifferencePct: 0.05,
    protectionMode: 'delta_neutral',
    reentryBufferPct: null,
    flipCooldownSec: null,
    maxSequentialFlips: null,
    breakoutConfirmDistancePct: null,
    breakoutConfirmDurationSec: null,
    dynamicState: null,
    bandMode: 'adaptive',
    baseRebalancePriceMovePct: 3,
    rebalanceIntervalSec: 21600,
    targetHedgeRatio: 1,
    minRebalanceNotionalUsd: 50,
    maxSlippageBps: 20,
    twapMinNotionalUsd: 10000,
    strategyState: { status: 'healthy' },
    valueMode: 'usd',
    leverage: 5,
    marginMode: 'isolated',
    poolSnapshot: { id: 'pool-1' },
    createdAt: 1234567890,
  };
}

function maxPlaceholder(sql) {
  return Math.max(...Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])));
}

test('create usa placeholders consistentes con la cantidad de parámetros', async () => {
  let capturedSql = '';
  let capturedParams = [];

  await repository.create(buildRecord(), {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ id: 99 }] };
    },
  });

  assert.ok(capturedParams.length >= maxPlaceholder(capturedSql));
  assert.match(capturedSql, /'active'/);
});

test('reactivate usa placeholders consistentes con la cantidad de parámetros', async () => {
  let capturedSql = '';
  let capturedParams = [];

  await repository.reactivate(1, 99, {
    ...buildRecord(),
    updatedAt: 1234567999,
  }, {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ id: 99 }] };
    },
  });

  assert.equal(maxPlaceholder(capturedSql), capturedParams.length);
});
