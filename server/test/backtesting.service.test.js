const test = require('node:test');
const assert = require('node:assert/strict');

const backtestingService = require('../src/services/backtesting.service');
const strategiesService = require('../src/services/strategies.service');
const strategyEngine = require('../src/services/strategy-engine.service');
const backtestsRepository = require('../src/repositories/strategy-backtests.repository');

test('simulateBacktest valida strategyId requerido', async () => {
  await assert.rejects(
    backtestingService.simulateBacktest(1, {}),
    /strategyId es requerido/
  );
});

test('simulateBacktest valida rango custom completo', async () => {
  const originalGetStrategy = strategiesService.getStrategy;
  strategiesService.getStrategy = async () => ({
    id: 11,
    name: 'Trend Rider',
    assetUniverse: ['BTC'],
    timeframe: '15m',
    defaultParams: {},
    scriptSource: 'module.exports.evaluate = async () => signal.hold();',
  });

  try {
    await assert.rejects(
      backtestingService.simulateBacktest(1, {
        strategyId: 11,
        from: '2024-01-01T00:00:00.000Z',
      }),
      /from y to deben enviarse juntos/
    );
  } finally {
    strategiesService.getStrategy = originalGetStrategy;
  }
});

test('simulateBacktest normaliza config y persiste solo el resumen', async () => {
  const originalGetStrategy = strategiesService.getStrategy;
  const originalBuildValidationContext = strategiesService.buildValidationContext;
  const originalSimulateBacktest = strategyEngine.simulateBacktest;
  const originalUpsert = backtestsRepository.upsert;

  strategiesService.getStrategy = async () => ({
    id: 11,
    name: 'Trend Rider',
    assetUniverse: ['BTC'],
    timeframe: '15m',
    defaultParams: { fastPeriod: 9 },
    scriptSource: 'module.exports.evaluate = async () => signal.hold();',
  });
  strategiesService.buildValidationContext = async () => ({
    asset: 'BTC',
    timeframe: '15m',
    customIndicators: [],
    context: {
      market: {
        candles: [
          { time: 1000, closeTime: 2000, open: 100, high: 101, low: 99, close: 100 },
          { time: 2000, closeTime: 3000, open: 100, high: 102, low: 98, close: 101 },
        ],
      },
      account: { position: null },
      params: { fastPeriod: 9 },
    },
  });
  strategyEngine.simulateBacktest = async (payload) => ({
    metrics: { trades: 2, netPnl: 10 },
    candles: payload.baseContext.market.candles,
    trades: [],
    signals: [],
    positionSegments: [],
    equitySeries: [],
    drawdownSeries: [],
    overlays: [],
    assumptions: { entryMode: 'close_with_slippage' },
  });

  let persisted = null;
  backtestsRepository.upsert = async (_userId, _strategyId, payload) => {
    persisted = payload;
  };

  try {
    const result = await backtestingService.simulateBacktest(1, {
      strategyId: 11,
      sizeUsd: 250,
      leverage: 5,
      overlayRequests: [{ kind: 'builtin', slug: 'ema', pane: 'price' }],
    });

    assert.equal(result.config.sizeUsd, 250);
    assert.equal(result.config.leverage, 5);
    assert.equal(result.config.asset, 'BTC');
    assert.equal(result.metrics.trades, 2);
    assert.equal(result.config.overlayRequests.length, 1);
    assert.deepEqual(JSON.parse(persisted.summaryJson), { trades: 2, netPnl: 10 });
  } finally {
    strategiesService.getStrategy = originalGetStrategy;
    strategiesService.buildValidationContext = originalBuildValidationContext;
    strategyEngine.simulateBacktest = originalSimulateBacktest;
    backtestsRepository.upsert = originalUpsert;
  }
});
