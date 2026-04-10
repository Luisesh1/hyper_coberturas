const backtestsRepository = require('../repositories/strategy-backtests.repository');
const strategyEngine = require('./strategy-engine.service');
const strategiesService = require('./strategies.service');
const marketDataService = require('./market-data.service');
const { ValidationError } = require('../errors/app-error');

const BUY_AND_HOLD_SOURCE = `module.exports.evaluate = async function evaluate(ctx) {
  const position = ctx.account.position();
  const candles = ctx.market.candles({ limit: 100000 });
  if (!position && candles.length === 1) return signal.long({ tag: 'buy_hold_entry' });
  return signal.hold();
};`;

function parseJsonObject(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const timestamp = Number(new Date(value).getTime());
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeOverlayRequests(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => ({
      id: item?.id || `overlay-${index}`,
      kind: item?.kind === 'custom' ? 'custom' : 'builtin',
      slug: String(item?.slug || '').trim(),
      params: parseJsonObject(item?.params, {}),
      pane: item?.pane === 'separate' ? 'separate' : 'price',
    }))
    .filter((item) => item.slug);
}

function normalizeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function resolveStrategyForSimulation(userId, input = {}) {
  return strategiesService.resolveRuntimeStrategy(userId, {
    strategyId: input.strategyId,
    draftStrategy: input.draftStrategy,
  });
}

function buildConfig({
  strategy,
  strategyId,
  strategyMode,
  asset,
  timeframe,
  params,
  sizeUsd,
  leverage,
  marginMode,
  stopLossPct,
  takeProfitPct,
  feeBps,
  slippageBps,
  limit,
  from,
  to,
  overlayRequests,
  benchmark,
}) {
  return {
    strategyId,
    strategyName: strategy?.name || null,
    strategyMode,
    asset,
    timeframe,
    params,
    sizeUsd,
    leverage,
    marginMode,
    stopLossPct: stopLossPct > 0 ? stopLossPct : null,
    takeProfitPct: takeProfitPct > 0 ? takeProfitPct : null,
    feeBps,
    slippageBps,
    limit: from && to ? null : limit,
    from,
    to,
    overlayRequests,
    benchmark: benchmark || null,
  };
}

async function buildBenchmarks({
  strategy,
  validationContext,
  sizingMode,
  sizeUsd,
  pctEquity,
  leverage,
  marginMode,
  stopLossPct,
  takeProfitPct,
  feeBps,
  slippageBps,
  overlayRequests,
  asset,
  timeframe,
  limit,
  from,
  to,
}) {
  const benchmarkInputs = [
    {
      key: 'buyHold',
      label: 'Buy & Hold',
      source: BUY_AND_HOLD_SOURCE,
      feeBps,
      slippageBps,
    },
    {
      key: 'noCosts',
      label: 'Misma estrategia sin costos',
      source: strategy.scriptSource,
      feeBps: 0,
      slippageBps: 0,
    },
  ];

  const results = await Promise.all(
    benchmarkInputs.map(async (benchmark) => {
      const result = await strategyEngine.simulateBacktest({
        source: benchmark.source,
        baseContext: validationContext.context,
        customIndicators: validationContext.customIndicators,
        sizingMode,
        sizeUsd,
        pctEquity,
        leverage,
        marginMode,
        stopLossPct,
        takeProfitPct,
        feeBps: benchmark.feeBps,
        slippageBps: benchmark.slippageBps,
        overlayRequests,
      });

      return [
        benchmark.key,
        {
          key: benchmark.key,
          label: benchmark.label,
          config: buildConfig({
            strategy,
            strategyId: null,
            strategyMode: 'benchmark',
            asset,
            timeframe,
            params: validationContext.context.params,
            sizeUsd,
            leverage,
            marginMode,
            stopLossPct,
            takeProfitPct,
            feeBps: benchmark.feeBps,
            slippageBps: benchmark.slippageBps,
            limit,
            from,
            to,
            overlayRequests,
            benchmark: benchmark.key,
          }),
          metrics: result.metrics,
          equitySeries: result.equitySeries,
          drawdownSeries: result.drawdownSeries,
          assumptions: result.assumptions,
          trades: result.trades,
          signals: result.signals,
        },
      ];
    }),
  );

  return Object.fromEntries(results);
}

async function simulateBacktest(userId, input = {}, { timeoutMs } = {}) {
  const { strategy, strategyId, mode: strategyMode, shouldPersist } = await resolveStrategyForSimulation(userId, input);
  if (!strategy) {
    throw new ValidationError('strategyId o draftStrategy es requerido');
  }

  const asset = marketDataService.normalizeAsset(input.asset || strategy.assetUniverse?.[0] || 'BTC');
  const timeframe = marketDataService.normalizeTimeframe(input.timeframe || strategy.timeframe || '15m');
  const limit = Math.max(50, Math.min(1000, normalizeNumber(input.limit, 500)));
  const from = normalizeTimestamp(input.from);
  const to = normalizeTimestamp(input.to);
  if ((from && !to) || (!from && to)) {
    throw new ValidationError('from y to deben enviarse juntos');
  }
  if (from && to && from >= to) {
    throw new ValidationError('from debe ser menor que to');
  }

  const validationContext = await strategiesService.buildValidationContext(userId, strategy, {
    asset,
    timeframe,
    params: parseJsonObject(input.params, {}),
    limit,
    from,
    to,
    force: true,
  });

  const sizeUsd = Math.max(1, normalizeNumber(
    input.sizeUsd,
    validationContext.context.params.sizeUsd || validationContext.context.params.size || 100,
  ));
  const leverage = Math.max(1, normalizeNumber(input.leverage, 10));
  const marginMode = input.marginMode === 'isolated' ? 'isolated' : 'cross';
  const stopLossPct = normalizeNumber(input.stopLossPct);
  const takeProfitPct = normalizeNumber(input.takeProfitPct);
  const feeBps = Math.max(0, normalizeNumber(input.feeBps, 0));
  const slippageBps = Math.max(0, normalizeNumber(input.slippageBps, 0));
  const overlayRequests = normalizeOverlayRequests(input.overlayRequests);

  const sizingMode = ['usd', 'qty', 'pct_equity'].includes(input.sizingMode) ? input.sizingMode : 'usd';
  const pctEquity = normalizeNumber(input.pctEquity, 10);

  const result = await strategyEngine.simulateBacktest({
    source: strategy.scriptSource,
    baseContext: validationContext.context,
    customIndicators: validationContext.customIndicators,
    sizingMode,
    sizeUsd,
    pctEquity,
    leverage,
    marginMode,
    stopLossPct,
    takeProfitPct,
    feeBps,
    slippageBps,
    overlayRequests,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  const candles = validationContext.context.market.candles;
  if (shouldPersist && strategyId) {
    await backtestsRepository.upsert(userId, strategyId, {
      summaryJson: JSON.stringify(result.metrics),
      rangeStart: candles[0]?.time || null,
      rangeEnd: candles[candles.length - 1]?.closeTime || null,
      now: Date.now(),
    });
  }

  const benchmarks = await buildBenchmarks({
    strategy,
    validationContext,
    sizingMode,
    sizeUsd,
    pctEquity,
    leverage,
    marginMode,
    stopLossPct,
    takeProfitPct,
    feeBps,
    slippageBps,
    overlayRequests,
    asset,
    timeframe,
    limit,
    from,
    to,
  });

  return {
    config: buildConfig({
      strategy,
      strategyId,
      strategyMode,
      asset,
      timeframe,
      params: validationContext.context.params,
      sizeUsd,
      leverage,
      marginMode,
      stopLossPct,
      takeProfitPct,
      feeBps,
      slippageBps,
      limit,
      from,
      to,
      overlayRequests,
    }),
    ...result,
    benchmarks,
  };
}

module.exports = {
  simulateBacktest,
};
