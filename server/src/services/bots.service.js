const botsRepository = require('../repositories/bots.repository');
const strategiesRepository = require('../repositories/strategies.repository');
const strategyIndicatorsRepository = require('../repositories/strategy-indicators.repository');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const strategyEngine = require('./strategy-engine.service');
const marketDataService = require('./market-data.service');
const { ValidationError, NotFoundError } = require('../errors/app-error');

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapBot(row) {
  if (!row) return null;
  const sizeUsd = Number(row.size);
  return {
    id: row.id,
    userId: row.user_id,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    accountId: row.hyperliquid_account_id,
    account: {
      id: row.hyperliquid_account_id,
      alias: row.account_alias,
      address: row.account_address,
      shortAddress: row.account_address
        ? `${row.account_address.slice(0, 6)}...${row.account_address.slice(-4)}`
        : '',
    },
    asset: row.asset,
    timeframe: row.timeframe || row.strategy_timeframe || '15m',
    params: parseJson(row.params_json, {}),
    leverage: Number(row.leverage),
    marginMode: row.margin_mode,
    size: sizeUsd,
    sizeUsd,
    stopLossPct: row.stop_loss_pct != null ? Number(row.stop_loss_pct) : null,
    takeProfitPct: row.take_profit_pct != null ? Number(row.take_profit_pct) : null,
    status: row.status,
    lastCandleAt: row.last_candle_at ? Number(row.last_candle_at) : null,
    lastSignalHash: row.last_signal_hash || null,
    lastError: row.last_error || null,
    lastEvaluatedAt: row.last_evaluated_at ? Number(row.last_evaluated_at) : null,
    lastSignal: parseJson(row.last_signal_json, null),
    runtime: {
      state: row.runtime_state || 'healthy',
      consecutiveFailures: Number(row.consecutive_failures || 0),
      nextRetryAt: row.next_retry_at ? Number(row.next_retry_at) : null,
      lastRecoveryAt: row.last_recovery_at ? Number(row.last_recovery_at) : null,
      lastRecoveryAction: row.last_recovery_action || null,
      systemPauseReason: row.system_pause_reason || null,
      context: parseJson(row.runtime_context_json, {}),
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    strategy: {
      id: row.strategy_id,
      name: row.strategy_name,
      timeframe: row.strategy_timeframe,
      defaultParams: parseJson(row.strategy_default_params_json, {}),
      latestBacktest: row.backtest_summary_json ? parseJson(row.backtest_summary_json, {}) : null,
    },
  };
}

function mapRun(row) {
  return {
    id: row.id,
    botId: row.bot_instance_id,
    userId: row.user_id,
    status: row.status,
    action: row.action,
    signal: parseJson(row.signal_json, null),
    candleTime: row.candle_time ? Number(row.candle_time) : null,
    price: row.price != null ? Number(row.price) : null,
    details: parseJson(row.details_json, {}),
    createdAt: Number(row.created_at),
  };
}

async function getBotRow(userId, botId) {
  const row = await botsRepository.getById(userId, botId);
  if (!row) throw new NotFoundError('Bot no encontrado');
  return row;
}

async function ensureStrategy(userId, strategyId) {
  const row = await strategiesRepository.getById(userId, strategyId);
  if (!row) throw new ValidationError('strategyId invalido');
  return row;
}

function normalizeParams(value) {
  const parsed = parseJson(value, {});
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  throw new ValidationError('params debe ser un objeto JSON');
}

async function normalizeInput(userId, input = {}, current = null) {
  const strategyId = Number(input.strategyId ?? current?.strategyId);
  if (!strategyId) throw new ValidationError('strategyId es requerido');
  const strategy = await ensureStrategy(userId, strategyId);
  const strategyAssets = parseJson(strategy.asset_universe_json, ['BTC']);

  const accountId = Number(input.accountId ?? current?.accountId);
  if (!accountId) throw new ValidationError('accountId es requerido');
  await hyperliquidAccountsService.getAccount(userId, accountId);

  const asset = marketDataService.normalizeAsset(input.asset || current?.asset || strategyAssets[0] || 'BTC');
  const timeframe = marketDataService.normalizeTimeframe(input.timeframe || current?.timeframe || strategy.timeframe || '15m');
  const leverage = Number(input.leverage ?? current?.leverage ?? 10);
  const sizeUsd = Number(input.sizeUsd ?? input.size ?? current?.sizeUsd ?? current?.size ?? 0);
  if (!Number.isFinite(leverage) || leverage <= 0) throw new ValidationError('leverage debe ser positivo');
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new ValidationError('sizeUsd debe ser positivo');

  const params = normalizeParams(input.params ?? current?.params ?? {});
  const marginMode = String(input.marginMode ?? current?.marginMode ?? 'cross').trim() || 'cross';
  if (!['cross', 'isolated'].includes(marginMode)) {
    throw new ValidationError('marginMode debe ser cross o isolated');
  }

  const stopLossPct = input.stopLossPct ?? current?.stopLossPct ?? null;
  const takeProfitPct = input.takeProfitPct ?? current?.takeProfitPct ?? null;
  const normalizedStopLoss = stopLossPct == null || stopLossPct === '' ? null : Number(stopLossPct);
  const normalizedTakeProfit = takeProfitPct == null || takeProfitPct === '' ? null : Number(takeProfitPct);
  if (normalizedStopLoss != null && (!Number.isFinite(normalizedStopLoss) || normalizedStopLoss <= 0)) {
    throw new ValidationError('stopLossPct debe ser positivo');
  }
  if (normalizedTakeProfit != null && (!Number.isFinite(normalizedTakeProfit) || normalizedTakeProfit <= 0)) {
    throw new ValidationError('takeProfitPct debe ser positivo');
  }

  const candles = await marketDataService.getCandles(asset, timeframe, { limit: 250 });
  const indicators = await strategyIndicatorsRepository.listByUser(userId);
  await strategyEngine.validateStrategy({
    source: strategy.script_source,
    context: {
      market: { candles },
      account: { position: null },
      params: {
        ...parseJson(strategy.default_params_json, {}),
        ...params,
      },
    },
    customIndicators: indicators.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      scriptSource: row.script_source,
      parameterSchema: parseJson(row.parameter_schema_json, {}),
    })),
  });

  return {
    strategyId,
    accountId,
    asset,
    timeframe,
    params,
    leverage,
    marginMode,
    size: sizeUsd,
    sizeUsd,
    stopLossPct: normalizedStopLoss,
    takeProfitPct: normalizedTakeProfit,
  };
}

async function listBots(userId) {
  const rows = await botsRepository.listByUser(userId);
  return rows.map(mapBot);
}

async function getBot(userId, botId) {
  return mapBot(await getBotRow(userId, botId));
}

async function createBot(userId, input) {
  const payload = await normalizeInput(userId, input);
  const row = await botsRepository.create(userId, {
    ...payload,
    paramsJson: JSON.stringify(payload.params),
    status: input.status && ['draft', 'paused', 'stopped'].includes(input.status) ? input.status : 'draft',
    now: Date.now(),
  });
  return getBot(userId, row.id);
}

async function updateBot(userId, botId, input) {
  const current = await getBot(userId, botId);
  if (current.status === 'active') {
    throw new ValidationError('No se puede editar un bot activo. Paúsalo primero.');
  }
  const payload = await normalizeInput(userId, input, current);
  const row = await botsRepository.update(userId, botId, {
    ...payload,
    paramsJson: JSON.stringify(payload.params),
    now: Date.now(),
  });
  if (!row) throw new NotFoundError('Bot no encontrado');
  return getBot(userId, row.id);
}

async function deleteBot(userId, botId) {
  const current = await getBot(userId, botId);
  if (current.status === 'active') {
    throw new ValidationError('No se puede eliminar un bot activo. Deténlo primero.');
  }
  const removed = await botsRepository.remove(userId, botId);
  if (!removed) throw new NotFoundError('Bot no encontrado');
  return { removed: true };
}

async function duplicateBot(userId, botId) {
  const current = await getBot(userId, botId);
  const row = await botsRepository.create(userId, {
    strategyId: current.strategyId,
    accountId: current.accountId,
    asset: current.asset,
    timeframe: current.timeframe,
    paramsJson: JSON.stringify(current.params || {}),
    leverage: current.leverage,
    marginMode: current.marginMode,
    size: current.size,
    stopLossPct: current.stopLossPct,
    takeProfitPct: current.takeProfitPct,
    status: 'draft',
    now: Date.now(),
  });
  return getBot(userId, row.id);
}

async function listBotRuns(userId, botId) {
  await getBotRow(userId, botId);
  const rows = await botsRepository.listRuns(userId, botId);
  return rows.map(mapRun);
}

module.exports = {
  createBot,
  deleteBot,
  duplicateBot,
  getBot,
  listBotRuns,
  listBots,
  mapBot,
  mapRun,
  updateBot,
};
