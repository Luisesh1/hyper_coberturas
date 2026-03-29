const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
  computeVolatilityStats,
  deriveBandSettings,
} = require('../src/services/protected-pool-delta-neutral.service');

test('computeVolatilityStats devuelve RV de 4h y 24h', () => {
  const candles = Array.from({ length: 24 }, (_, index) => ({
    close: 100 + (index * 2),
  }));

  const stats = computeVolatilityStats(candles);

  assert.equal(Number.isFinite(stats.rv4hPct), true);
  assert.equal(Number.isFinite(stats.rv24hPct), true);
  assert.ok(stats.rv24hPct >= 0);
});

test('deriveBandSettings usa max(rv4h, rv24h) y estrecha la banda cerca del borde', () => {
  const settings = deriveBandSettings({
    bandMode: 'adaptive',
    rangeLowerPrice: 2400,
    rangeUpperPrice: 2600,
  }, {
    rv4hPct: 85,
    rv24hPct: 35,
  }, {
    normalizedGamma: 0.25,
  }, 2505);

  assert.equal(settings.rv4hPct, 85);
  assert.equal(settings.rv24hPct, 35);
  assert.equal(settings.baseBandPct, 1);
  assert.equal(settings.intervalSec, 3600);
  assert.equal(settings.effectiveBandPct, 0.5);
});

test('auto top-up usa un cap diario fijo basado en el notional inicial', async () => {
  let marginUpdates = 0;
  const service = new ProtectedPoolDeltaNeutralService();

  const blocked = await service._maybeTopUpMargin({
    protection: {
      inferredAsset: 'ETH',
      configuredHedgeNotionalUsd: 1_000,
      initialConfiguredHedgeNotionalUsd: 1_000,
    },
    hl: {
      getAssetMeta: async () => ({ index: 0 }),
      updateIsolatedMargin: async () => {
        marginUpdates += 1;
      },
    },
    currentPrice: 3_000,
    actualQty: 1,
    strategyState: {
      topUpCount24h: 2,
      topUpUsd24h: 240,
      topUpWindowStartedAt: Date.now(),
    },
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.success, false);
  assert.match(blocked.reason, /cap diario/i);
  assert.equal(marginUpdates, 0);
});

test('runTwap registra slices completados cuando queda parcial', async () => {
  const service = new ProtectedPoolDeltaNeutralService();
  let closeCalls = 0;

  const result = await service._runTwap({
    protection: {
      id: 77,
      inferredAsset: 'ETH',
      leverage: 5,
    },
    tradingService: {
      closePosition: async ({ size }) => {
        closeCalls += 1;
        if (closeCalls === 1) {
          return { closePrice: 2500 + size };
        }
        throw new Error('slice failed');
      },
    },
    hl: {},
    currentPrice: 2500,
    driftQty: -0.5,
  });

  assert.equal(result.partial, true);
  assert.equal(result.twapSlicesPlanned, 5);
  assert.equal(result.twapSlicesCompleted, 1);
  assert.ok(result.executedQty > 0);
});
