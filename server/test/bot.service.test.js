const test = require('node:test');
const assert = require('node:assert/strict');

const { BotRuntime } = require('../src/services/bot.service');
const botsRepository = require('../src/repositories/bots.repository');
const strategiesRepository = require('../src/repositories/strategies.repository');
const strategyIndicatorsRepository = require('../src/repositories/strategy-indicators.repository');
const marketDataService = require('../src/services/market-data.service');
const strategyEngine = require('../src/services/strategy-engine.service');
const balanceCacheService = require('../src/services/balance-cache.service');

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

function createBotRow(overrides = {}) {
  return {
    id: 21,
    user_id: 1,
    strategy_id: 7,
    hyperliquid_account_id: 3,
    asset: 'BTC',
    timeframe: '15m',
    params_json: '{}',
    leverage: 10,
    margin_mode: 'cross',
    size: 100,
    stop_loss_pct: null,
    take_profit_pct: null,
    status: 'active',
    last_candle_at: null,
    last_signal_hash: null,
    last_error: null,
    last_evaluated_at: null,
    last_signal_json: null,
    runtime_state: 'healthy',
    consecutive_failures: 0,
    next_retry_at: null,
    last_recovery_at: null,
    last_recovery_action: null,
    system_pause_reason: null,
    runtime_context_json: '{}',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function createHarness(initialRow = createBotRow()) {
  let currentRow = initialRow;
  let runId = 1;
  const runs = [];

  const releaseRepo = withPatched(botsRepository, {
    getById: async () => currentRow,
    updateRuntime: async (_userId, _botId, payload) => {
      currentRow = createBotRow({
        ...currentRow,
        status: payload.status,
        last_candle_at: payload.lastCandleAt,
        last_signal_hash: payload.lastSignalHash,
        last_error: payload.lastError,
        last_evaluated_at: payload.lastEvaluatedAt,
        last_signal_json: payload.lastSignalJson,
        runtime_state: payload.runtimeState,
        consecutive_failures: payload.consecutiveFailures,
        next_retry_at: payload.nextRetryAt,
        last_recovery_at: payload.lastRecoveryAt,
        last_recovery_action: payload.lastRecoveryAction,
        system_pause_reason: payload.systemPauseReason,
        runtime_context_json: payload.runtimeContextJson,
        updated_at: payload.updatedAt,
      });
      return currentRow;
    },
    appendRun: async (_userId, botId, payload) => {
      const row = {
        id: runId += 1,
        bot_instance_id: botId,
        user_id: 1,
        status: payload.status,
        action: payload.action,
        signal_json: payload.signalJson,
        candle_time: payload.candleTime,
        price: payload.price,
        details_json: payload.detailsJson,
        created_at: payload.createdAt,
      };
      runs.push(row);
      return row;
    },
  });

  return {
    get currentRow() {
      return currentRow;
    },
    runs,
    release: releaseRepo,
  };
}

function patchStaticDeps() {
  const releaseStrategies = withPatched(strategiesRepository, {
    getById: async () => ({
      id: 7,
      script_source: 'async function evaluate(){ return { signal: { type: "hold" } }; }',
      default_params_json: '{}',
    }),
  });
  const releaseIndicators = withPatched(strategyIndicatorsRepository, {
    listByUser: async () => [],
  });
  return () => {
    releaseStrategies();
    releaseIndicators();
  };
}

test('usa fallback cacheado, registra el error fechado y vuelve a healthy', async () => {
  const harness = createHarness();
  const releaseStatic = patchStaticDeps();
  const releaseMarket = withPatched(marketDataService, {
    getCandles: async () => {
      throw new Error('Market down');
    },
    getCachedCandles: () => [{
      time: Date.now() - 120000,
      closeTime: Date.now() - 60000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      trades: 1,
    }],
  });
  const releaseBalance = withPatched(balanceCacheService, {
    getSnapshot: async () => ({
      positions: [],
      openOrders: [],
      lastUpdatedAt: Date.now(),
    }),
    getCachedSnapshot: () => null,
  });
  const releaseEngine = withPatched(strategyEngine, {
    validateStrategy: async () => ({ signal: { type: 'hold' } }),
  });

  try {
    const runtime = new BotRuntime(1, harness.currentRow, {
      tg: { notifyBotRuntimeEvent: () => {} },
    });

    const result = await runtime.evaluateLatest({ force: true });

    assert.equal(result.execution.action, 'hold');
    assert.equal(runtime.bot.runtime.state, 'healthy');
    assert.equal(runtime.bot.lastError, null);
    assert.equal(harness.runs.some((row) => row.status === 'warning' && row.action === 'fallback_cache_used'), true);
    assert.equal(harness.runs.some((row) => row.status === 'recovered' && row.action === 'runtime_recovered'), true);
    assert.equal(harness.runs.some((row) => row.status === 'success' && row.action === 'hold'), true);
    assert.equal(harness.runs.every((row) => Number.isFinite(Number(row.created_at))), true);
  } finally {
    harness.release();
    releaseStatic();
    releaseMarket();
    releaseBalance();
    releaseEngine();
  }
});

test('programa retry con backoff inicial y conserva el bot activo ante un error recuperable', async () => {
  const harness = createHarness();
  const releaseStatic = patchStaticDeps();
  const runtimeEvents = [];
  const releaseMarket = withPatched(marketDataService, {
    getCandles: async () => {
      throw new Error('Market down');
    },
    getCachedCandles: () => null,
  });
  const releaseBalance = withPatched(balanceCacheService, {
    getSnapshot: async () => {
      throw new Error('Balance no deberia consultarse');
    },
    getCachedSnapshot: () => null,
  });
  const releaseEngine = withPatched(strategyEngine, {
    validateStrategy: async () => ({ signal: { type: 'hold' } }),
  });
  const startedAt = Date.now();

  try {
    const runtime = new BotRuntime(1, harness.currentRow, {
      tg: {
        notifyBotRuntimeEvent: (event, _bot, payload) => {
          runtimeEvents.push({ event, payload });
        },
      },
    });

    const result = await runtime.evaluateLatest({ force: true });

    assert.equal(result, null);
    assert.equal(runtime.bot.status, 'active');
    assert.equal(runtime.bot.runtime.state, 'retrying');
    assert.equal(runtime.bot.runtime.consecutiveFailures, 1);
    assert.equal(runtime.bot.lastError, 'Market down');
    assert.ok(runtime.bot.runtime.nextRetryAt >= (startedAt + 14_000));
    assert.ok(runtime.bot.runtime.nextRetryAt <= (startedAt + 17_000));
    assert.equal(harness.runs.some((row) => row.status === 'error' && row.action === 'market_data_failed'), true);
    assert.equal(harness.runs.some((row) => row.status === 'warning' && row.action === 'retry_scheduled'), true);
    assert.deepEqual(runtimeEvents.map((item) => item.event), ['runtime_warning', 'runtime_retry_scheduled']);
    assert.equal(runtimeEvents[1].payload.actionTaken, 'Reintento programado');
  } finally {
    harness.release();
    releaseStatic();
    releaseMarket();
    releaseBalance();
    releaseEngine();
  }
});

test('auto pausa el bot al alcanzar el umbral de fallos consecutivos y registra el evento fechado', async () => {
  const harness = createHarness(createBotRow({
    runtime_state: 'retrying',
    consecutive_failures: 4,
    next_retry_at: null,
    runtime_context_json: JSON.stringify({
      degradedStartedAt: Date.now() - 5_000,
    }),
  }));
  const releaseStatic = patchStaticDeps();
  const runtimeEvents = [];
  const releaseMarket = withPatched(marketDataService, {
    getCandles: async () => {
      throw new Error('Market down');
    },
    getCachedCandles: () => null,
  });
  const releaseBalance = withPatched(balanceCacheService, {
    getSnapshot: async () => {
      throw new Error('Balance no deberia consultarse');
    },
    getCachedSnapshot: () => null,
  });
  const releaseEngine = withPatched(strategyEngine, {
    validateStrategy: async () => ({ signal: { type: 'hold' } }),
  });

  try {
    const runtime = new BotRuntime(1, harness.currentRow, {
      tg: {
        notifyBotRuntimeEvent: (event, _bot, payload) => {
          runtimeEvents.push({ event, payload });
        },
      },
    });

    const result = await runtime.evaluateLatest({ force: true });

    assert.equal(result, null);
    assert.equal(runtime.bot.status, 'paused');
    assert.equal(runtime.bot.runtime.state, 'paused_by_system');
    assert.equal(runtime.bot.runtime.consecutiveFailures, 5);
    assert.equal(runtime.bot.runtime.nextRetryAt, null);
    assert.equal(runtime.bot.runtime.lastRecoveryAction, 'system_paused');
    assert.equal(runtime.bot.runtime.systemPauseReason, 'Market down');
    assert.equal(harness.runs.some((row) => row.status === 'paused' && row.action === 'system_paused'), true);
    assert.equal(harness.runs.every((row) => Number.isFinite(Number(row.created_at))), true);
    assert.deepEqual(runtimeEvents.map((item) => item.event), ['runtime_paused']);
    assert.match(runtimeEvents[0].payload.actionTaken, /pausado/i);
  } finally {
    harness.release();
    releaseStatic();
    releaseMarket();
    releaseBalance();
    releaseEngine();
  }
});
