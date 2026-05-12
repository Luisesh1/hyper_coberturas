const test = require('node:test');
const assert = require('node:assert/strict');

const { BotRuntime } = require('../src/services/bot.service');
const botsService = require('../src/services/bots.service');
const botsRepository = require('../src/repositories/bots.repository');
const strategiesRepository = require('../src/repositories/strategies.repository');
const strategyIndicatorsRepository = require('../src/repositories/strategy-indicators.repository');
const marketDataService = require('../src/services/market-data.service');
const strategyEngine = require('../src/services/strategy-engine.service');
const balanceCacheService = require('../src/services/balance-cache.service');
const hyperliquidAccountsService = require('../src/services/hyperliquid-accounts.service');
const {
  STRATEGY_SOURCE: SQZMOM_EMA55_SOURCE,
  getDefaultParams: getSqzmomEma55Params,
} = require('../src/scripts/seed-sqzmom-ema55-strategy');

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

function buildClosedCandles(length = 260) {
  const now = Date.now();
  const start = now - ((length + 2) * 60_000);
  return Array.from({ length }, (_item, index) => {
    const close = 100 + (Math.sin(index / 8) * 6) + (index * 0.03);
    return {
      time: start + (index * 60_000),
      closeTime: start + ((index + 1) * 60_000),
      open: close - 0.5,
      high: close + 1.2,
      low: close - 1.1,
      close: Number(close.toFixed(4)),
      volume: 100 + index,
      trades: 10,
    };
  });
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

test('bot evalua SQZMOM EMA55 con parametros del bot sin abrir entradas deshabilitadas', async () => {
  const params = {
    ...getSqzmomEma55Params(),
    enableLong: false,
    enableShort: false,
    useTrueRange: false,
    lengthBB: 18,
    lengthKC: 24,
    emaLen: 34,
    periodNR: 80,
    atrPeriod: 5,
    atrScale: 1.4,
  };
  const harness = createHarness(createBotRow({
    params_json: JSON.stringify(params),
  }));
  const releaseStrategies = withPatched(strategiesRepository, {
    getById: async () => ({
      id: 7,
      script_source: SQZMOM_EMA55_SOURCE,
      default_params_json: JSON.stringify(getSqzmomEma55Params()),
    }),
  });
  const releaseIndicators = withPatched(strategyIndicatorsRepository, {
    listByUser: async () => [],
  });
  const releaseMarket = withPatched(marketDataService, {
    getCandles: async () => buildClosedCandles(260),
    getCachedCandles: () => null,
  });
  const releaseBalance = withPatched(balanceCacheService, {
    getSnapshot: async () => ({
      positions: [],
      openOrders: [],
      lastUpdatedAt: Date.now(),
    }),
    getCachedSnapshot: () => null,
  });

  try {
    const runtime = new BotRuntime(1, harness.currentRow);
    runtime.applySignal = async (signal) => ({
      action: signal.type,
      details: { testedStrategy: 'sqzmom_ema55' },
    });

    const result = await runtime.evaluateLatest({ force: true });

    assert.equal(result.signal.type, 'hold');
    assert.equal(result.execution.action, 'hold');
    assert.equal(runtime.bot.runtime.state, 'healthy');
    assert.equal(harness.runs.some((row) => row.status === 'success' && row.action === 'hold'), true);
  } finally {
    harness.release();
    releaseStrategies();
    releaseIndicators();
    releaseMarket();
    releaseBalance();
  }
});

test('createBot permite estrategia agnostica y valida con asset/timeframe configurados en el bot', async () => {
  let createdPayload = null;
  let validatedContext = null;
  const releaseStrategies = withPatched(strategiesRepository, {
    getById: async () => ({
      id: 7,
      name: 'SQZMOM Agnostic',
      asset_universe_json: JSON.stringify(['*']),
      timeframe: '15m',
      script_source: SQZMOM_EMA55_SOURCE,
      default_params_json: JSON.stringify(getSqzmomEma55Params()),
    }),
  });
  const releaseAccounts = withPatched(hyperliquidAccountsService, {
    getAccount: async () => ({ id: 3, alias: 'Main', address: '0x1234' }),
  });
  const releaseIndicators = withPatched(strategyIndicatorsRepository, {
    listByUser: async () => [],
  });
  const releaseMarket = withPatched(marketDataService, {
    getCandles: async (asset, timeframe) => {
      assert.equal(asset, 'ETH');
      assert.equal(timeframe, '1h');
      return buildClosedCandles(260);
    },
  });
  const releaseEngine = withPatched(strategyEngine, {
    validateStrategy: async ({ context }) => {
      validatedContext = context;
      return { signal: { type: 'hold' }, diagnostics: { candles: 260 } };
    },
  });
  const releaseRepo = withPatched(botsRepository, {
    create: async (_userId, payload) => {
      createdPayload = payload;
      return createBotRow({
        id: 44,
        strategy_id: payload.strategyId,
        hyperliquid_account_id: payload.accountId,
        asset: payload.asset,
        timeframe: payload.timeframe,
        params_json: payload.paramsJson,
        leverage: payload.leverage,
        margin_mode: payload.marginMode,
        size: payload.size,
        status: payload.status,
      });
    },
    getById: async () => createBotRow({
      id: 44,
      strategy_id: createdPayload.strategyId,
      strategy_name: 'SQZMOM Agnostic',
      strategy_timeframe: '15m',
      strategy_default_params_json: JSON.stringify(getSqzmomEma55Params()),
      hyperliquid_account_id: createdPayload.accountId,
      account_alias: 'Main',
      account_address: '0x1234',
      asset: createdPayload.asset,
      timeframe: createdPayload.timeframe,
      params_json: createdPayload.paramsJson,
      leverage: createdPayload.leverage,
      margin_mode: createdPayload.marginMode,
      size: createdPayload.size,
      stop_loss_pct: createdPayload.stopLossPct,
      take_profit_pct: createdPayload.takeProfitPct,
      status: createdPayload.status,
      backtest_summary_json: null,
    }),
  });

  try {
    const bot = await botsService.createBot(1, {
      strategyId: 7,
      accountId: 3,
      asset: 'ETH',
      timeframe: '1h',
      sizeUsd: 150,
      leverage: 3,
      params: { emaLen: 34, enableShort: false },
    });

    assert.equal(bot.asset, 'ETH');
    assert.equal(bot.timeframe, '1h');
    assert.equal(createdPayload.asset, 'ETH');
    assert.equal(createdPayload.timeframe, '1h');
    assert.equal(validatedContext.params.emaLen, 34);
    assert.equal(validatedContext.params.enableShort, false);
  } finally {
    releaseStrategies();
    releaseAccounts();
    releaseIndicators();
    releaseMarket();
    releaseEngine();
    releaseRepo();
  }
});
