const test = require('node:test');
const assert = require('node:assert/strict');

const backtestingService = require('../src/services/backtesting.service');
const strategiesService = require('../src/services/strategies.service');
const strategyEngine = require('../src/services/strategy-engine.service');
const backtestsRepository = require('../src/repositories/strategy-backtests.repository');

test('simulateBacktest valida strategyId o draftStrategy requerido', async () => {
  await assert.rejects(
    backtestingService.simulateBacktest(1, {}),
    /strategyId o draftStrategy es requerido/
  );
});

test('simulateBacktest valida rango custom completo', async () => {
  const originalResolveRuntimeStrategy = strategiesService.resolveRuntimeStrategy;
  strategiesService.resolveRuntimeStrategy = async () => ({
    strategy: {
      id: 11,
      name: 'Trend Rider',
      assetUniverse: ['BTC'],
      timeframe: '15m',
      defaultParams: {},
      scriptSource: 'module.exports.evaluate = async () => signal.hold();',
    },
    strategyId: 11,
    mode: 'saved',
    shouldPersist: true,
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
    strategiesService.resolveRuntimeStrategy = originalResolveRuntimeStrategy;
  }
});

test('simulateBacktest soporta draftStrategy sin persistir latestBacktest', async () => {
  const originalResolveRuntimeStrategy = strategiesService.resolveRuntimeStrategy;
  const originalBuildValidationContext = strategiesService.buildValidationContext;
  const originalSimulateBacktest = strategyEngine.simulateBacktest;
  const originalUpsert = backtestsRepository.upsert;

  strategiesService.resolveRuntimeStrategy = async () => ({
    strategy: {
      id: null,
      name: 'Draft Alpha',
      assetUniverse: ['BTC'],
      timeframe: '15m',
      defaultParams: { fastPeriod: 9 },
      scriptSource: 'module.exports.evaluate = async () => signal.hold();',
    },
    strategyId: null,
    mode: 'draft',
    shouldPersist: false,
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

  let calls = 0;
  strategyEngine.simulateBacktest = async () => {
    calls += 1;
    return {
      metrics: { trades: 2, netPnl: 10, expectancy: 5 },
      candles: [],
      trades: [],
      signals: [],
      positionSegments: [],
      equitySeries: [],
      drawdownSeries: [],
      overlays: [],
      assumptions: { entryMode: 'close_with_slippage' },
    };
  };

  let persisted = false;
  backtestsRepository.upsert = async () => {
    persisted = true;
  };

  try {
    const result = await backtestingService.simulateBacktest(1, {
      draftStrategy: {
        name: 'Draft Alpha',
        assetUniverse: ['BTC'],
        timeframe: '15m',
        defaultParams: { fastPeriod: 9 },
        scriptSource: 'module.exports.evaluate = async () => signal.hold();',
      },
    });

    assert.equal(result.config.strategyMode, 'draft');
    assert.equal(result.config.strategyId, null);
    assert.equal(result.config.strategyName, 'Draft Alpha');
    assert.equal(result.benchmarks.buyHold.label, 'Buy & Hold');
    assert.equal(result.benchmarks.noCosts.label, 'Misma estrategia sin costos');
    assert.equal(calls, 3);
    assert.equal(persisted, false);
  } finally {
    strategiesService.resolveRuntimeStrategy = originalResolveRuntimeStrategy;
    strategiesService.buildValidationContext = originalBuildValidationContext;
    strategyEngine.simulateBacktest = originalSimulateBacktest;
    backtestsRepository.upsert = originalUpsert;
  }
});

test('simulateBacktest normaliza config, añade benchmarks y persiste solo para estrategias guardadas', async () => {
  const originalResolveRuntimeStrategy = strategiesService.resolveRuntimeStrategy;
  const originalBuildValidationContext = strategiesService.buildValidationContext;
  const originalSimulateBacktest = strategyEngine.simulateBacktest;
  const originalUpsert = backtestsRepository.upsert;

  strategiesService.resolveRuntimeStrategy = async () => ({
    strategy: {
      id: 11,
      name: 'Trend Rider',
      assetUniverse: ['BTC'],
      timeframe: '15m',
      defaultParams: { fastPeriod: 9 },
      scriptSource: 'module.exports.evaluate = async () => signal.hold();',
    },
    strategyId: 11,
    mode: 'saved',
    shouldPersist: true,
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

  let callIndex = 0;
  strategyEngine.simulateBacktest = async () => {
    callIndex += 1;
    return {
      metrics: { trades: callIndex, netPnl: 10 * callIndex, expectancy: 5 * callIndex },
      candles: [],
      trades: [],
      signals: [],
      positionSegments: [],
      equitySeries: [],
      drawdownSeries: [],
      overlays: [],
      assumptions: { entryMode: 'close_with_slippage' },
    };
  };

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
    assert.equal(result.config.strategyMode, 'saved');
    assert.equal(result.metrics.trades, 1);
    assert.equal(result.config.overlayRequests.length, 1);
    assert.equal(result.benchmarks.buyHold.metrics.trades, 2);
    assert.equal(result.benchmarks.noCosts.metrics.trades, 3);
    assert.deepEqual(JSON.parse(persisted.summaryJson), { trades: 1, netPnl: 10, expectancy: 5 });
  } finally {
    strategiesService.resolveRuntimeStrategy = originalResolveRuntimeStrategy;
    strategiesService.buildValidationContext = originalBuildValidationContext;
    strategyEngine.simulateBacktest = originalSimulateBacktest;
    backtestsRepository.upsert = originalUpsert;
  }
});
