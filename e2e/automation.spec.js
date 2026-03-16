const { test, expect } = require('@playwright/test');

function buildApiMockState() {
  const strategies = [{
    id: 11,
    name: 'Trend Rider',
    description: 'Cruce EMA',
    assetUniverse: ['BTC'],
    timeframe: '15m',
    defaultParams: { fastPeriod: 9, slowPeriod: 21, size: 0.01 },
    scriptSource: 'module.exports.evaluate = async function evaluate(ctx) { return signal.hold(); };',
    isActiveDraft: true,
    latestBacktest: {
      summary: { trades: 4, winRate: 75, netPnl: 14.2 },
      rangeStart: Date.now() - 1_000_000,
      rangeEnd: Date.now(),
      updatedAt: Date.now(),
    },
    updatedAt: Date.now(),
  }];

  const indicators = [{
    id: 7,
    name: 'Volume Z-Score',
    slug: 'volume-zscore',
    parameterSchema: { defaults: { period: 10 } },
    scriptSource: 'module.exports.compute = function compute() { return []; };',
  }];

  const bots = [{
    id: 21,
    strategyId: 11,
    strategyName: 'Trend Rider',
    accountId: 1,
    account: {
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000AA',
      shortAddress: '0x0000...00AA',
    },
    asset: 'BTC',
    timeframe: '15m',
    params: { fastPeriod: 9 },
    leverage: 10,
    marginMode: 'cross',
    size: 0.01,
    stopLossPct: 1.5,
    takeProfitPct: 3,
    status: 'draft',
    lastSignal: null,
    lastError: null,
    lastEvaluatedAt: null,
    lastCandleAt: null,
    runtime: {
      state: 'healthy',
      consecutiveFailures: 0,
      nextRetryAt: null,
      lastRecoveryAt: null,
      lastRecoveryAction: null,
      systemPauseReason: null,
      context: {},
    },
  }, {
    id: 23,
    strategyId: 11,
    strategyName: 'Trend Rider',
    accountId: 1,
    account: {
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000AA',
      shortAddress: '0x0000...00AA',
    },
    asset: 'ETH',
    timeframe: '5m',
    params: { fastPeriod: 9 },
    leverage: 8,
    marginMode: 'cross',
    size: 0.02,
    stopLossPct: 1,
    takeProfitPct: 2,
    status: 'active',
    lastSignal: { type: 'hold' },
    lastError: 'Sin velas',
    lastEvaluatedAt: Date.now() - 60_000,
    lastCandleAt: Date.now() - 120_000,
    runtime: {
      state: 'retrying',
      consecutiveFailures: 2,
      nextRetryAt: Date.now() + 90_000,
      lastRecoveryAt: Date.now() - 30_000,
      lastRecoveryAction: 'market_data_failed',
      systemPauseReason: null,
      context: { stage: 'market_data' },
    },
  }];

  const runsByBot = {
    21: [{
      id: 1,
      action: 'hold',
      status: 'success',
      signal: { type: 'hold' },
      price: 100000,
      createdAt: Date.now(),
    }],
    23: [{
      id: 10,
      action: 'market_data_failed',
      status: 'error',
      signal: null,
      details: { message: 'Sin velas recientes', actionTaken: 'Programando reintento' },
      price: null,
      createdAt: Date.now() - 60_000,
    }, {
      id: 11,
      action: 'retry_scheduled',
      status: 'warning',
      signal: null,
      details: { message: 'Sin velas recientes', actionTaken: 'Reintento programado' },
      price: null,
      createdAt: Date.now() - 30_000,
    }],
  };

  const backtestResponse = {
    config: {
      strategyId: 11,
      asset: 'BTC',
      timeframe: '15m',
      limit: 500,
      sizeUsd: 100,
      leverage: 10,
      marginMode: 'cross',
    },
    metrics: {
      trades: 3,
      winRate: 66.67,
      netPnl: 42.15,
      maxDrawdown: 11.2,
      profitFactor: 1.9,
      avgTrade: 14.05,
    },
    candles: [
      { time: 1710000000000, closeTime: 1710000900000, open: 100, high: 103, low: 99, close: 102, volume: 10 },
      { time: 1710000900000, closeTime: 1710001800000, open: 102, high: 106, low: 101, close: 105, volume: 12 },
      { time: 1710001800000, closeTime: 1710002700000, open: 105, high: 107, low: 104, close: 106, volume: 11 },
      { time: 1710002700000, closeTime: 1710003600000, open: 106, high: 108, low: 103, close: 104, volume: 13 },
    ],
    trades: [
      {
        side: 'long',
        entryTime: 1710000900000,
        exitTime: 1710002700000,
        entryPrice: 102,
        exitPrice: 106,
        qty: 0.98,
        sizeUsd: 100,
        pnl: 3.92,
        reason: 'signal_reverse',
      },
      {
        side: 'short',
        entryTime: 1710002700000,
        exitTime: 1710003600000,
        entryPrice: 106,
        exitPrice: 104,
        qty: 0.94,
        sizeUsd: 100,
        pnl: 1.88,
        reason: 'end_of_range',
      },
    ],
    signals: [
      { closeTime: 1710000900000, type: 'long', action: 'open_long', price: 102 },
      { closeTime: 1710002700000, type: 'short', action: 'reverse', price: 106 },
      { closeTime: 1710003600000, type: 'hold', action: 'hold', price: 104 },
    ],
    positionSegments: [
      { side: 'long', entryTime: 1710000900000, exitTime: 1710002700000, entryPrice: 102, exitPrice: 106, pnl: 3.92, reason: 'signal_reverse' },
      { side: 'short', entryTime: 1710002700000, exitTime: 1710003600000, entryPrice: 106, exitPrice: 104, pnl: 1.88, reason: 'end_of_range' },
    ],
    equitySeries: [
      { time: 1710000900000, value: 0 },
      { time: 1710001800000, value: 2.5 },
      { time: 1710002700000, value: 3.92 },
      { time: 1710003600000, value: 5.8 },
    ],
    drawdownSeries: [
      { time: 1710000900000, value: 0 },
      { time: 1710001800000, value: 0 },
      { time: 1710002700000, value: 1.2 },
      { time: 1710003600000, value: 0.3 },
    ],
    overlays: [{
      id: 'overlay-ema-9',
      kind: 'builtin',
      slug: 'ema',
      pane: 'price',
      series: [{
        id: 'ema:value',
        label: 'ema',
        points: [
          { time: 1710000900000, value: 101.5 },
          { time: 1710001800000, value: 103.2 },
          { time: 1710002700000, value: 104.0 },
          { time: 1710003600000, value: 104.1 },
        ],
      }],
    }],
    assumptions: {
      entryMode: 'close_with_slippage',
      stopTpMode: 'intrabar_next_candle',
      sameCandleConflictPolicy: 'stop_first',
    },
  };

  return { strategies, indicators, bots, runsByBot, backtestResponse };
}

async function mockApi(page) {
  const state = buildApiMockState();

  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1,
      userId: 1,
      username: 'admin',
      name: 'Administrador',
      role: 'superuser',
    }));
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();

    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/settings/hyperliquid-accounts' && method === 'GET') {
      return json([{
        id: 1,
        alias: 'Cuenta Alpha',
        address: '0x00000000000000000000000000000000000000AA',
        shortAddress: '0x0000...00AA',
        label: 'Cuenta Alpha · 0x0000...00AA',
        balanceUsd: 1234,
        isDefault: true,
      }]);
    }

    if (pathname === '/api/strategies' && method === 'GET') return json(state.strategies);
    if (pathname === '/api/indicators' && method === 'GET') return json(state.indicators);
    if (pathname === '/api/bots' && method === 'GET') return json(state.bots);

    if (pathname === '/api/strategies' && method === 'POST') {
      const body = route.request().postDataJSON();
      const item = {
        id: 12,
        ...body,
        latestBacktest: null,
        updatedAt: Date.now(),
      };
      state.strategies.unshift(item);
      return json(item, 201);
    }

    const strategyMatch = pathname.match(/^\/api\/strategies\/(\d+)$/);
    if (strategyMatch && method === 'GET') {
      const strategy = state.strategies.find((item) => item.id === Number(strategyMatch[1]));
      return json(strategy);
    }

    const validateMatch = pathname.match(/^\/api\/strategies\/(\d+)\/validate$/);
    if (validateMatch && method === 'POST') {
      return json({
        asset: 'BTC',
        timeframe: '15m',
        signal: { type: 'long' },
        diagnostics: { candles: 250 },
      });
    }

    const backtestMatch = pathname.match(/^\/api\/strategies\/(\d+)\/backtest$/);
    if (backtestMatch && method === 'POST') {
      return json({
        metrics: { trades: 8, winRate: 62.5, netPnl: 12.5, maxDrawdown: 3.1, profitFactor: 1.8 },
        trades: [{ side: 'long', entryPrice: 100, exitPrice: 105, pnl: 5 }],
      });
    }

    if (pathname === '/api/backtesting/simulate' && method === 'POST') {
      return json(state.backtestResponse);
    }

    if (pathname === '/api/indicators' && method === 'POST') {
      const body = route.request().postDataJSON();
      const indicator = { id: 8, ...body };
      state.indicators.unshift(indicator);
      return json(indicator, 201);
    }

    if (pathname === '/api/bots' && method === 'POST') {
      const body = route.request().postDataJSON();
      const bot = {
        id: 22,
        ...body,
        strategyName: state.strategies.find((item) => item.id === Number(body.strategyId))?.name || 'Nueva estrategia',
        account: {
          id: 1,
          alias: 'Cuenta Alpha',
          address: '0x00000000000000000000000000000000000000AA',
          shortAddress: '0x0000...00AA',
        },
        status: 'draft',
        lastSignal: null,
        lastError: null,
        lastEvaluatedAt: null,
        lastCandleAt: null,
        runtime: {
          state: 'healthy',
          consecutiveFailures: 0,
          nextRetryAt: null,
          lastRecoveryAt: null,
          lastRecoveryAction: null,
          systemPauseReason: null,
          context: {},
        },
      };
      state.bots.unshift(bot);
      state.runsByBot[22] = [];
      return json(bot, 201);
    }

    const botMatch = pathname.match(/^\/api\/bots\/(\d+)$/);
    if (botMatch && method === 'GET') {
      const bot = state.bots.find((item) => item.id === Number(botMatch[1]));
      return json(bot);
    }

    const botRunsMatch = pathname.match(/^\/api\/bots\/(\d+)\/runs$/);
    if (botRunsMatch && method === 'GET') {
      return json(state.runsByBot[Number(botRunsMatch[1])] || []);
    }

    const botActivateMatch = pathname.match(/^\/api\/bots\/(\d+)\/activate$/);
    if (botActivateMatch && method === 'POST') {
      const bot = state.bots.find((item) => item.id === Number(botActivateMatch[1]));
      if (bot) bot.status = 'active';
      return json(bot);
    }

    const botPauseMatch = pathname.match(/^\/api\/bots\/(\d+)\/pause$/);
    if (botPauseMatch && method === 'POST') {
      const bot = state.bots.find((item) => item.id === Number(botPauseMatch[1]));
      if (bot) bot.status = 'paused';
      return json(bot);
    }

    const botDuplicateMatch = pathname.match(/^\/api\/bots\/(\d+)\/duplicate$/);
    if (botDuplicateMatch && method === 'POST') {
      const original = state.bots.find((item) => item.id === Number(botDuplicateMatch[1]));
      const clone = { ...original, id: 99, status: 'draft' };
      state.bots.unshift(clone);
      state.runsByBot[99] = [];
      return json(clone, 201);
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: `Unhandled mock for ${method} ${pathname}` }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('Strategy Studio permite validar y backtestear una estrategia', async ({ page }) => {
  await page.goto('/estrategias');

  await expect(page.getByText('Strategy Studio')).toBeVisible();
  await expect(page.getByText('Trend Rider')).toBeVisible();
  await page.getByRole('button', { name: /Trend Rider/i }).click();
  await page.getByRole('button', { name: 'Validar' }).click();
  await expect(page.getByText('Signal: long')).toBeVisible();
  await page.getByRole('button', { name: 'Backtest', exact: true }).click();
  await expect(page.getByText('8 trades')).toBeVisible();
  await expect(page.getByText('Volume Z-Score')).toBeVisible();
});

test('Bots permite activar y pausar una instancia existente', async ({ page }) => {
  await page.goto('/bots');

  await expect(page.getByText('Bot Control Room')).toBeVisible();
  await expect(page.getByText('#21 · BTC')).toBeVisible();
  await page.getByRole('button', { name: /#21 · BTC/i }).click();
  await page.getByRole('button', { name: 'Activar' }).click();
  await expect(page.getByRole('button', { name: /#21 · BTC active Trend Rider/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.getByRole('button', { name: /#21 · BTC paused Trend Rider/ })).toBeVisible();
  await expect(page.getByText('Signal: hold')).toBeVisible();
});

test('Bots muestra runtime en recovery y permite filtrar incidentes', async ({ page }) => {
  await page.goto('/bots');

  await expect(page.getByText('en recovery')).toBeVisible();
  await expect(page.getByText('retrying')).toBeVisible();

  await page.getByRole('button', { name: /Errores/i }).click();
  await expect(page.getByRole('button', { name: /#23 · ETH/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /#21 · BTC/i })).toHaveCount(0);

  await page.getByRole('button', { name: /#23 · ETH/i }).click();
  await expect(page.locator('strong').filter({ hasText: 'market_data_failed' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Solo errores' }).click();
  await expect(page.getByText('Sin velas recientes')).toBeVisible();
});

test('Backtesting permite correr una simulacion e inspeccionar trades', async ({ page }) => {
  await page.goto('/backtesting');

  await expect(page.getByText('Backtesting Lab')).toBeVisible();
  await page.getByLabel('Estrategia', { exact: true }).selectOption('11');
  await page.getByRole('button', { name: 'Simular backtest' }).click();
  await expect(page.getByText('Net PnL', { exact: true })).toBeVisible();
  await expect(page.getByTestId('backtest-chart')).toBeVisible();
  await expect(page.getByText('signal_reverse')).toBeVisible();
  await page.getByText('signal_reverse').click();
  await expect(page.locator('tr').filter({ hasText: 'signal_reverse' })).toBeVisible();
  await page.getByRole('button', { name: 'win' }).click();
  await expect(page.getByRole('button', { name: 'win' })).toHaveClass(/filterBtnActive/);
});
