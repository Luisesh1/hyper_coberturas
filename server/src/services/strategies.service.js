const strategiesRepository = require('../repositories/strategies.repository');
const indicatorsRepository = require('../repositories/strategy-indicators.repository');
const backtestsRepository = require('../repositories/strategy-backtests.repository');
const strategyEngine = require('./strategy-engine.service');
const marketDataService = require('./market-data.service');
const { ValidationError, NotFoundError } = require('../errors/app-error');

const DEFAULT_STRATEGY_SOURCE = `module.exports.evaluate = async function evaluate(ctx) {
  const closes = ctx.market.candles({ limit: 100 });
  const fast = ctx.indicators.ema(closes, { period: 9 });
  const slow = ctx.indicators.ema(closes, { period: 21 });
  const fastLast = ctx.indicators.last(fast);
  const slowLast = ctx.indicators.last(slow);
  const position = ctx.account.position();

  if (fastLast == null || slowLast == null) return signal.hold();
  if (!position && fastLast > slowLast) return signal.long();
  if (!position && fastLast < slowLast) return signal.short();
  if (position?.side === 'long' && fastLast < slowLast) return signal.close();
  if (position?.side === 'short' && fastLast > slowLast) return signal.close();
  return signal.hold();
};`;

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAssetUniverse(assetUniverse) {
  const values = Array.isArray(assetUniverse)
    ? assetUniverse
    : String(assetUniverse || 'BTC').split(',');
  const normalized = values
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
  if (normalized.length === 0) return ['BTC'];
  return [...new Set(normalized)];
}

function normalizeDefaultParams(value) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function normalizeRuntimeStrategyInput(input = {}, { requireName = false } = {}) {
  const name = String(input.name || '').trim();
  if (requireName && !name) throw new ValidationError('name es requerido');

  const timeframe = marketDataService.normalizeTimeframe(input.timeframe || '15m');
  const assetUniverse = normalizeAssetUniverse(input.assetUniverse);
  const scriptSource = String(input.scriptSource || '').trim() || DEFAULT_STRATEGY_SOURCE;
  if (!scriptSource) throw new ValidationError('scriptSource es requerido');

  return {
    id: input.id != null ? Number(input.id) : null,
    name: name || 'Draft strategy',
    description: String(input.description || '').trim(),
    assetUniverse,
    timeframe,
    scriptSource,
    defaultParams: normalizeDefaultParams(input.defaultParams),
    isActiveDraft: input.isActiveDraft !== undefined ? !!input.isActiveDraft : true,
  };
}

function mapStrategy(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || '',
    assetUniverse: parseJson(row.asset_universe_json, ['BTC']),
    timeframe: row.timeframe,
    scriptSource: row.script_source,
    defaultParams: parseJson(row.default_params_json, {}),
    isActiveDraft: !!row.is_active_draft,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    latestBacktest: row.backtest_summary_json
      ? {
          summary: parseJson(row.backtest_summary_json, {}),
          rangeStart: row.backtest_range_start ? Number(row.backtest_range_start) : null,
          rangeEnd: row.backtest_range_end ? Number(row.backtest_range_end) : null,
          updatedAt: row.backtest_updated_at ? Number(row.backtest_updated_at) : null,
        }
      : null,
  };
}

function normalizeStrategyInput(input = {}) {
  return normalizeRuntimeStrategyInput(input, { requireName: true });
}

async function resolveRuntimeStrategy(userId, { strategyId, draftStrategy } = {}) {
  const parsedId = Number(strategyId);
  const hasDraftStrategy = draftStrategy && typeof draftStrategy === 'object';
  let baseStrategy = null;

  if (Number.isFinite(parsedId) && parsedId > 0) {
    baseStrategy = await getStrategy(userId, parsedId);
  }

  if (!baseStrategy && !hasDraftStrategy) {
    throw new ValidationError('strategyId o draftStrategy es requerido');
  }

  if (!hasDraftStrategy) {
    return {
      strategy: baseStrategy,
      strategyId: baseStrategy?.id || null,
      mode: 'saved',
      shouldPersist: !!baseStrategy,
    };
  }

  const mergedDraft = normalizeRuntimeStrategyInput({
    ...baseStrategy,
    ...draftStrategy,
    assetUniverse: draftStrategy.assetUniverse ?? baseStrategy?.assetUniverse,
    timeframe: draftStrategy.timeframe ?? baseStrategy?.timeframe,
    scriptSource: draftStrategy.scriptSource ?? baseStrategy?.scriptSource,
    defaultParams: {
      ...(baseStrategy?.defaultParams || {}),
      ...normalizeDefaultParams(draftStrategy.defaultParams),
    },
    isActiveDraft: draftStrategy.isActiveDraft ?? baseStrategy?.isActiveDraft,
  });

  return {
    strategy: mergedDraft,
    strategyId: baseStrategy?.id || null,
    mode: 'draft',
    shouldPersist: false,
  };
}

async function buildValidationContext(userId, strategy, overrides = {}) {
  const asset = marketDataService.normalizeAsset(overrides.asset || strategy.assetUniverse[0] || 'BTC');
  const timeframe = marketDataService.normalizeTimeframe(overrides.timeframe || strategy.timeframe);
  const candles = await marketDataService.getCandles(asset, timeframe, {
    limit: overrides.limit || 250,
    startTime: overrides.startTime || overrides.from,
    endTime: overrides.endTime || overrides.to,
    force: !!overrides.force,
  });
  const indicators = await indicatorsRepository.listByUser(userId);
  const position = overrides.position && typeof overrides.position === 'object' ? overrides.position : null;

  return {
    asset,
    timeframe,
    candles,
    customIndicators: indicators.map(mapIndicatorRow),
    context: {
      market: { candles },
      account: { position },
      params: {
        ...strategy.defaultParams,
        ...(normalizeDefaultParams(overrides.params)),
      },
    },
  };
}

function mapIndicatorRow(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    scriptSource: row.script_source,
    parameterSchema: parseJson(row.parameter_schema_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function listStrategies(userId) {
  const rows = await strategiesRepository.listByUser(userId);
  return rows.map(mapStrategy);
}

async function getStrategy(userId, strategyId) {
  const row = await strategiesRepository.getById(userId, strategyId);
  if (!row) throw new NotFoundError('Estrategia no encontrada');
  return mapStrategy(row);
}

async function createStrategy(userId, input) {
  const strategy = normalizeStrategyInput(input);
  const validationContext = await buildValidationContext(userId, strategy, {
    asset: strategy.assetUniverse[0],
    timeframe: strategy.timeframe,
  });
  await strategyEngine.validateStrategy({
    source: strategy.scriptSource,
    context: validationContext.context,
    customIndicators: validationContext.customIndicators,
  });

  const row = await strategiesRepository.create(userId, {
    ...strategy,
    assetUniverseJson: JSON.stringify(strategy.assetUniverse),
    defaultParamsJson: JSON.stringify(strategy.defaultParams),
    now: Date.now(),
  });
  return getStrategy(userId, row.id);
}

async function updateStrategy(userId, strategyId, input) {
  const current = await getStrategy(userId, strategyId);
  const strategy = normalizeStrategyInput({
    ...current,
    ...input,
  });
  const validationContext = await buildValidationContext(userId, strategy, {
    asset: strategy.assetUniverse[0],
    timeframe: strategy.timeframe,
  });
  await strategyEngine.validateStrategy({
    source: strategy.scriptSource,
    context: validationContext.context,
    customIndicators: validationContext.customIndicators,
  });

  const row = await strategiesRepository.update(userId, strategyId, {
    ...strategy,
    assetUniverseJson: JSON.stringify(strategy.assetUniverse),
    defaultParamsJson: JSON.stringify(strategy.defaultParams),
    now: Date.now(),
  });
  if (!row) throw new NotFoundError('Estrategia no encontrada');
  return getStrategy(userId, row.id);
}

async function deleteStrategy(userId, strategyId) {
  const removed = await strategiesRepository.remove(userId, strategyId);
  if (!removed) throw new NotFoundError('Estrategia no encontrada');
  return { removed: true };
}

async function validateStrategy(userId, strategyId, overrides = {}) {
  const strategy = await getStrategy(userId, strategyId);
  const validationContext = await buildValidationContext(userId, strategy, overrides);
  const result = await strategyEngine.validateStrategy({
    source: strategy.scriptSource,
    context: validationContext.context,
    customIndicators: validationContext.customIndicators,
  });
  return {
    asset: validationContext.asset,
    timeframe: validationContext.timeframe,
    signal: result.signal,
    diagnostics: result.diagnostics,
  };
}

async function validateDraftStrategy(userId, input = {}) {
  const { strategy } = await resolveRuntimeStrategy(userId, {
    strategyId: input.strategyId,
    draftStrategy: input.draftStrategy || input,
  });
  const validationContext = await buildValidationContext(userId, strategy, {
    asset: input.asset,
    timeframe: input.timeframe,
    params: input.params,
    limit: input.limit,
    from: input.from,
    to: input.to,
    force: true,
  });
  const result = await strategyEngine.validateStrategy({
    source: strategy.scriptSource,
    context: validationContext.context,
    customIndicators: validationContext.customIndicators,
  });
  return {
    asset: validationContext.asset,
    timeframe: validationContext.timeframe,
    signal: result.signal,
    diagnostics: result.diagnostics,
  };
}

async function backtestStrategy(userId, strategyId, options = {}) {
  const strategy = await getStrategy(userId, strategyId);
  const validationContext = await buildValidationContext(userId, strategy, {
    asset: options.asset,
    timeframe: options.timeframe,
    params: options.params,
    limit: options.limit || 300,
    force: true,
  });
  const result = await strategyEngine.backtestStrategy({
    source: strategy.scriptSource,
    baseContext: validationContext.context,
    customIndicators: validationContext.customIndicators,
    tradeSize: Number(options.tradeSize || validationContext.context.params.size || 1),
  });

  const candles = validationContext.context.market.candles;
  await backtestsRepository.upsert(userId, strategyId, {
    summaryJson: JSON.stringify(result.metrics),
    rangeStart: candles[0]?.time || null,
    rangeEnd: candles[candles.length - 1]?.closeTime || null,
    now: Date.now(),
  });

  return {
    asset: validationContext.asset,
    timeframe: validationContext.timeframe,
    metrics: result.metrics,
    trades: result.trades,
  };
}

module.exports = {
  DEFAULT_STRATEGY_SOURCE,
  backtestStrategy,
  buildValidationContext,
  createStrategy,
  deleteStrategy,
  getStrategy,
  listStrategies,
  mapIndicatorRow,
  mapStrategy,
  normalizeRuntimeStrategyInput,
  resolveRuntimeStrategy,
  updateStrategy,
  validateDraftStrategy,
  validateStrategy,
};
