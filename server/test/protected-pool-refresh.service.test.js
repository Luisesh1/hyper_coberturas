const test = require('node:test');
const assert = require('node:assert/strict');

const { ProtectedPoolRefreshService } = require('../src/services/protected-pool-refresh.service');

test('protected pool refresh actualiza snapshots activos agrupando por wallet/red/version', async () => {
  const updates = [];
  const scans = [];
  const refreshService = new ProtectedPoolRefreshService({
    refreshIntervalMs: 600000,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    protectedPoolRepository: {
      listActiveForRefresh: async () => ([
        {
          id: 10,
          userId: 1,
          walletAddress: '0xabc',
          network: 'ethereum',
          version: 'v3',
          positionIdentifier: '123',
          token0Symbol: 'BTC',
          token1Symbol: 'USDC',
          token0Address: '0x1',
          token1Address: '0x2',
        },
        {
          id: 11,
          userId: 1,
          walletAddress: '0xabc',
          network: 'ethereum',
          version: 'v3',
          positionIdentifier: '456',
          token0Symbol: 'ETH',
          token1Symbol: 'USDC',
          token0Address: '0x3',
          token1Address: '0x4',
        },
      ]),
      updateSnapshot: async (userId, id, record) => {
        updates.push({ userId, id, record });
      },
    },
    uniswapService: {
      scanPoolsCreatedByWallet: async (payload) => {
        scans.push(payload);
        return ({
        pools: [
          {
            identifier: '123',
            poolAddress: '0xpool1',
            token0: { symbol: 'BTC' },
            token1: { symbol: 'USDC' },
            token0Address: '0x1',
            token1Address: '0x2',
            rangeLowerPrice: 49000,
            rangeUpperPrice: 51000,
            priceCurrent: 50050,
            currentValueUsd: 1000,
            initialValueUsd: 900,
            unclaimedFeesUsd: 10,
            pnlTotalUsd: 110,
            yieldPct: 12.22,
            mode: 'lp_position',
            version: 'v3',
          },
          {
            identifier: '456',
            poolAddress: '0xpool2',
            token0: { symbol: 'ETH' },
            token1: { symbol: 'USDC' },
            token0Address: '0x3',
            token1Address: '0x4',
            rangeLowerPrice: 2400,
            rangeUpperPrice: 2600,
            priceCurrent: 2500,
            currentValueUsd: 800,
            initialValueUsd: 700,
            unclaimedFeesUsd: 12,
            pnlTotalUsd: 112,
            yieldPct: 16,
            mode: 'lp_position',
            version: 'v3',
          },
        ],
        });
      },
    },
  });

  await refreshService.refreshAll();

  assert.equal(scans.length, 1);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].id, 10);
  assert.equal(updates[0].record.poolSnapshot.identifier, '123');
  assert.equal(updates[1].id, 11);
  assert.equal(updates[1].record.poolSnapshot.identifier, '456');
});

test('protected pool refresh permite forzar solo las protecciones de un usuario', async () => {
  const scans = [];
  const updates = [];
  const refreshService = new ProtectedPoolRefreshService({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    protectedPoolRepository: {
      listActiveForRefresh: async () => ([
        {
          id: 10,
          userId: 1,
          walletAddress: '0xabc',
          network: 'arbitrum',
          version: 'v4',
          positionIdentifier: '123',
        },
        {
          id: 11,
          userId: 2,
          walletAddress: '0xdef',
          network: 'arbitrum',
          version: 'v4',
          positionIdentifier: '999',
        },
      ]),
      updateSnapshot: async (userId, id, record) => {
        updates.push({ userId, id, record });
      },
    },
    uniswapService: {
      scanPoolsCreatedByWallet: async (payload) => {
        scans.push(payload);
        return {
          pools: [{
            identifier: '123',
            poolAddress: '0xpool1',
            token0: { symbol: 'WBTC' },
            token1: { symbol: 'USDC' },
            token0Address: '0x1',
            token1Address: '0x2',
            rangeLowerPrice: 69000,
            rangeUpperPrice: 78500,
            priceCurrent: 70900,
            mode: 'lp_position',
            version: 'v4',
          }],
        };
      },
    },
  });

  await refreshService.refreshUser(1);

  assert.equal(scans.length, 1);
  assert.equal(scans[0].userId, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 10);
});
