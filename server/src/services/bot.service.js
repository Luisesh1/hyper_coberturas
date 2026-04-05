const { EventEmitter } = require('events');
const { createHash } = require('crypto');
const botsRepository = require('../repositories/bots.repository');
const strategiesRepository = require('../repositories/strategies.repository');
const strategyIndicatorsRepository = require('../repositories/strategy-indicators.repository');
const marketDataService = require('./market-data.service');
const strategyEngine = require('./strategy-engine.service');
const balanceCacheService = require('./balance-cache.service');
const { getTradingService } = require('./trading.factory');
const config = require('../config');
const logger = require('./logger.service');

const INLINE_READ_RETRIES = 2;
const STRATEGY_RETRIES = 1;
const INLINE_RETRY_DELAY_MS = 250;

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function defaultRuntime() {
  return {
    state: 'healthy',
    consecutiveFailures: 0,
    nextRetryAt: null,
    lastRecoveryAt: null,
    lastRecoveryAction: null,
    systemPauseReason: null,
    context: {},
  };
}

function normalizeRuntime(row = {}) {
  return {
    state: row.runtime_state || 'healthy',
    consecutiveFailures: Number(row.consecutive_failures || 0),
    nextRetryAt: row.next_retry_at ? Number(row.next_retry_at) : null,
    lastRecoveryAt: row.last_recovery_at ? Number(row.last_recovery_at) : null,
    lastRecoveryAction: row.last_recovery_action || null,
    systemPauseReason: row.system_pause_reason || null,
    context: parseJson(row.runtime_context_json, {}),
  };
}

function mapBotRow(row) {
  const sizeUsd = Number(row.size);
  return {
    id: row.id,
    userId: row.user_id,
    strategyId: row.strategy_id,
    accountId: row.hyperliquid_account_id,
    asset: row.asset,
    timeframe: row.timeframe,
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
    runtime: normalizeRuntime(row),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapIndicatorRow(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    scriptSource: row.script_source,
    parameterSchema: parseJson(row.parameter_schema_json, {}),
  };
}

function normalizeSignal(signal) {
  if (!signal || typeof signal !== 'object') return { type: 'hold' };
  if (!['hold', 'long', 'short', 'close'].includes(signal.type)) {
    return { type: 'hold' };
  }
  return {
    type: signal.type,
    sizeMultiplier: signal.sizeMultiplier != null ? Number(signal.sizeMultiplier) : 1,
    meta: signal.meta && typeof signal.meta === 'object' ? signal.meta : {},
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRetrySchedule() {
  const base = Math.max(1_000, Number(config.bots.retryBaseMs) || 15_000);
  const max = Math.max(base, Number(config.bots.retryMaxMs) || 300_000);
  return [base, base * 2, base * 4, base * 8, base * 20].map((value) => Math.min(value, max));
}

function getRetryDelay(failureCount) {
  const schedule = buildRetrySchedule();
  return schedule[Math.min(Math.max(0, failureCount - 1), schedule.length - 1)];
}

function normalizeErrorMessage(error) {
  if (!error) return 'Error desconocido';
  return error.message || String(error);
}

class RuntimeStageError extends Error {
  constructor(stage, message, options = {}) {
    super(message);
    this.name = 'RuntimeStageError';
    this.stage = stage;
    this.action = options.action || null;
    this.code = options.code || null;
    this.cause = options.cause || null;
    this.signal = options.signal || null;
    this.candle = options.candle || null;
    this.referencePrice = options.referencePrice ?? null;
    this.position = options.position || null;
    this.desiredSide = options.desiredSide || null;
    this.executionSize = options.executionSize ?? null;
    this.nextState = options.nextState || null;
  }
}

class BotRuntime extends EventEmitter {
  constructor(userId, botRow, deps = {}) {
    super();
    this.userId = userId;
    this.bot = mapBotRow(botRow);
    this.timer = null;
    this.isEvaluating = false;
    this.tg = deps.tg || null;
  }

  _runtime() {
    const current = this.bot.runtime || defaultRuntime();
    return {
      ...defaultRuntime(),
      ...current,
      context: { ...(current.context || {}) },
    };
  }

  async refresh() {
    const row = await botsRepository.getById(this.userId, this.bot.id);
    if (!row) throw new Error(`Bot ${this.bot.id} no encontrado`);
    this.bot = {
      ...this.bot,
      ...mapBotRow(row),
    };
    return this.bot;
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.evaluateLatest().catch((err) => logger.warn('bot evaluateLatest loop error', { botId: this.bot?.id, error: err.message }));
    }, config.intervals.botEvalMs);
    this.timer.unref?.();
  }

  stopLoop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async activate() {
    this.startLoop();
    await this.persistRuntime({
      status: 'active',
      lastError: null,
      runtime: {
        ...defaultRuntime(),
        lastRecoveryAt: Date.now(),
        lastRecoveryAction: 'manual_activate',
      },
    });
    this.emit('status', this.bot);
    return this.bot;
  }

  async pause() {
    this.stopLoop();
    await this.persistRuntime({
      status: 'paused',
      lastError: null,
      runtime: {
        ...defaultRuntime(),
        lastRecoveryAt: Date.now(),
        lastRecoveryAction: 'manual_pause',
      },
    });
    this.emit('status', this.bot);
    return this.bot;
  }

  async stop() {
    this.stopLoop();
    await this.persistRuntime({
      status: 'stopped',
      lastError: null,
      lastSignalHash: null,
      runtime: {
        ...defaultRuntime(),
        lastRecoveryAt: Date.now(),
        lastRecoveryAction: 'manual_stop',
      },
    });
    this.emit('status', this.bot);
    return this.bot;
  }

  async persistRuntime(overrides = {}) {
    const now = Date.now();
    const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const runtime = {
      ...this._runtime(),
      ...(overrides.runtime || {}),
      context: {
        ...this._runtime().context,
        ...((overrides.runtime && overrides.runtime.context) || {}),
      },
    };
    const updatedRow = await botsRepository.updateRuntime(this.userId, this.bot.id, {
      status: overrides.status ?? this.bot.status,
      lastCandleAt: has('lastCandleAt') ? overrides.lastCandleAt : (this.bot.lastCandleAt ?? null),
      lastSignalHash: has('lastSignalHash') ? overrides.lastSignalHash : (this.bot.lastSignalHash ?? null),
      lastError: has('lastError') ? overrides.lastError : (this.bot.lastError ?? null),
      lastEvaluatedAt: has('lastEvaluatedAt') ? overrides.lastEvaluatedAt : (this.bot.lastEvaluatedAt ?? now),
      lastSignalJson: JSON.stringify(has('lastSignal') ? overrides.lastSignal : (this.bot.lastSignal ?? null)),
      runtimeState: runtime.state,
      consecutiveFailures: runtime.consecutiveFailures,
      nextRetryAt: runtime.nextRetryAt,
      lastRecoveryAt: runtime.lastRecoveryAt,
      lastRecoveryAction: runtime.lastRecoveryAction,
      systemPauseReason: runtime.systemPauseReason,
      runtimeContextJson: JSON.stringify(runtime.context || {}),
      updatedAt: now,
    });
    this.bot = {
      ...this.bot,
      ...mapBotRow(updatedRow),
      lastSignal: parseJson(updatedRow.last_signal_json, null),
    };
    return this.bot;
  }

  async appendRun(status, action, signal, candle, details = {}) {
    const row = await botsRepository.appendRun(this.userId, this.bot.id, {
      status,
      action,
      signalJson: JSON.stringify(signal || null),
      candleTime: candle?.closeTime || null,
      price: candle?.close ?? null,
      detailsJson: JSON.stringify(details || {}),
      createdAt: Date.now(),
    });
    const payload = {
      id: row.id,
      botId: this.bot.id,
      status: row.status,
      action: row.action,
      signal,
      candleTime: row.candle_time ? Number(row.candle_time) : null,
      price: row.price != null ? Number(row.price) : null,
      details: parseJson(row.details_json, {}),
      createdAt: Number(row.created_at),
    };
    this.emit('run', this.bot, payload);
    return payload;
  }

  _emitRuntimeEvent(event, payload = {}) {
    const fullPayload = {
      timestamp: Date.now(),
      ...payload,
    };
    this.emit(event, this.bot, fullPayload);
    this.tg?.notifyBotRuntimeEvent?.(event, this.bot, fullPayload);
  }

  _buildFailureAction(error) {
    if (error.action) return error.action;
    switch (error.stage) {
      case 'market_data': return 'market_data_failed';
      case 'balance_snapshot': return 'balance_snapshot_failed';
      case 'strategy': return /timeout|excedi[oó]/i.test(error.message) ? 'strategy_timeout' : 'strategy_failed';
      case 'execution': return 'execution_failed';
      case 'protection': return 'protection_failed';
      default: return 'runtime_failed';
    }
  }

  async _withInlineRetries(stage, operation, retries = INLINE_READ_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        await sleep(INLINE_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw new RuntimeStageError(stage, normalizeErrorMessage(lastError), {
      cause: lastError,
    });
  }

  _buildClosedTradeDetails(closeResult, extras = {}) {
    if (!closeResult || closeResult.action !== 'close') return null;
    return {
      asset: closeResult.asset || this.bot.asset,
      side: closeResult.closedSide || extras.side || null,
      size: closeResult.closedSize ?? null,
      entryPrice: closeResult.openPrice ?? null,
      closePrice: closeResult.closePrice ?? null,
      pnl: closeResult.pnl ?? null,
      ...extras,
    };
  }

  async _markFallback(stage, message, candle, details = {}) {
    const runtime = this._runtime();
    const now = Date.now();
    const nextContext = {
      ...runtime.context,
      degradedStartedAt: runtime.context?.degradedStartedAt || now,
      lastFailureAt: now,
      stage,
      message,
    };
    await this.persistRuntime({
      lastError: message,
      runtime: {
        ...runtime,
        state: 'degraded',
        lastRecoveryAt: now,
        lastRecoveryAction: details.action || 'fallback_cache_used',
        context: nextContext,
      },
    }).catch((err) => logger.warn('bot persistRuntime failed', { botId: this.bot?.id, error: err.message }));
    await this.appendRun('warning', details.action || 'fallback_cache_used', null, candle, {
      stage,
      message,
      actionTaken: details.actionTaken || 'Usando respaldo en cache',
      recoveryResult: details.recoveryResult || 'fallback_applied',
      ...details,
    }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
    this._emitRuntimeEvent('runtime_fallback_applied', {
      stage,
      message,
      actionTaken: details.actionTaken || 'Usando respaldo en cache',
      nextRetryAt: runtime.nextRetryAt,
    });
  }

  async _getCandles(force) {
    try {
      return await this._withInlineRetries('market_data', () => marketDataService.getCandles(this.bot.asset, this.bot.timeframe, {
        limit: 300,
        force,
      }));
    } catch (error) {
      const cached = marketDataService.getCachedCandles(this.bot.asset, this.bot.timeframe, {
        maxAgeMs: config.bots.maxStaleCandleMs,
      });
      if (cached?.length) {
        await this._markFallback('market_data', error.message, null, {
          action: 'fallback_cache_used',
          actionTaken: 'Usando velas cacheadas mientras se recupera market-data',
        });
        return cached;
      }
      throw new RuntimeStageError('market_data', error.message, {
        action: 'market_data_failed',
        cause: error,
      });
    }
  }

  async _getSnapshot(force) {
    try {
      return await this._withInlineRetries('balance_snapshot', () => balanceCacheService.getSnapshot(this.userId, this.bot.accountId, {
        force,
      }));
    } catch (error) {
      const cached = balanceCacheService.getCachedSnapshot(this.userId, this.bot.accountId, {
        maxAgeMs: config.bots.maxStaleBalanceMs,
      });
      if (cached) {
        await this._markFallback('balance_snapshot', error.message, null, {
          action: 'fallback_cache_used',
          actionTaken: 'Usando snapshot de cuenta cacheado mientras se recupera balance-cache',
        });
        return cached;
      }
      throw new RuntimeStageError('balance_snapshot', error.message, {
        action: 'balance_snapshot_failed',
        cause: error,
      });
    }
  }

  async _evaluateStrategy(strategyRow, indicatorRows, closedCandles, position) {
    let lastError = null;
    for (let attempt = 0; attempt <= STRATEGY_RETRIES; attempt += 1) {
      try {
        return await strategyEngine.validateStrategy({
          source: strategyRow.script_source,
          context: {
            market: { candles: closedCandles },
            account: { position },
            params: {
              ...parseJson(strategyRow.default_params_json, {}),
              ...this.bot.params,
            },
          },
          customIndicators: indicatorRows.map(mapIndicatorRow),
        });
      } catch (error) {
        lastError = error;
        if (attempt >= STRATEGY_RETRIES) break;
        await sleep(INLINE_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw new RuntimeStageError('strategy', normalizeErrorMessage(lastError), {
      action: /timeout|excedi[oó]/i.test(normalizeErrorMessage(lastError)) ? 'strategy_timeout' : 'strategy_failed',
      cause: lastError,
    });
  }

  _findPosition(snapshot) {
    return snapshot.positions.find((item) => String(item.asset).toUpperCase() === this.bot.asset) || null;
  }

  _buildProtectionPrices(signalType, referencePrice) {
    const slPrice = this.bot.stopLossPct
      ? signalType === 'long'
        ? referencePrice * (1 - (this.bot.stopLossPct / 100))
        : referencePrice * (1 + (this.bot.stopLossPct / 100))
      : undefined;
    const tpPrice = this.bot.takeProfitPct
      ? signalType === 'long'
        ? referencePrice * (1 + (this.bot.takeProfitPct / 100))
        : referencePrice * (1 - (this.bot.takeProfitPct / 100))
      : undefined;
    return { slPrice, tpPrice };
  }

  async _attemptExecutionRecovery(error) {
    if (!['execution', 'protection'].includes(error.stage) || !error.signal) return null;

    const snapshot = await balanceCacheService.getSnapshot(this.userId, this.bot.accountId, { force: true }).catch((err) => { logger.warn('bot getSnapshot failed', { botId: this.bot?.id, error: err.message }); return null; });
    if (!snapshot) return null;

    const position = this._findPosition(snapshot);
    const trading = await getTradingService(this.userId, this.bot.accountId);
    const details = {
      stage: error.stage,
      message: error.message,
      actionTaken: 'execution_reconciled',
      recoveryResult: null,
    };

    if (error.signal.type === 'close') {
      if (!position) {
        details.recoveryResult = 'position_already_closed';
        await this.appendRun('warning', 'execution_reconciled', error.signal, error.candle, details).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
        this._emitRuntimeEvent('runtime_fallback_applied', details);
        return {
          action: 'close_recovered',
          details: { reconciled: true, reason: 'position_already_closed' },
        };
      }
      return null;
    }

    if (!position || position.side !== error.signal.type) {
      return null;
    }

    if (this.bot.stopLossPct || this.bot.takeProfitPct) {
      const referencePrice = Number(error.referencePrice);
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;
      const { slPrice, tpPrice } = this._buildProtectionPrices(error.signal.type, referencePrice);
      const protectionResult = await trading.setSLTP({
        asset: this.bot.asset,
        side: error.signal.type,
        size: Math.abs(Number(position.size)),
        slPrice,
        tpPrice,
      }).catch((err) => { logger.warn('bot setSLTP recovery failed', { botId: this.bot?.id, error: err.message }); return null; });
      if (!protectionResult) return null;
    }

    details.recoveryResult = error.stage === 'protection'
      ? 'position_detected_and_protected'
      : 'position_detected_on_exchange';
    await this.appendRun('warning', 'execution_reconciled', error.signal, error.candle, details).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
    this._emitRuntimeEvent('runtime_fallback_applied', details);
    return {
      action: error.signal.type === 'long' ? 'open_long' : 'open_short',
      details: {
        reconciled: true,
        side: position.side,
        exchangeSize: Math.abs(Number(position.size)),
      },
    };
  }

  async _handleRuntimeFailure(error, { candle = null, signal = null } = {}) {
    const runtime = this._runtime();
    const now = Date.now();
    const nextFailureCount = runtime.consecutiveFailures + 1;
    const action = this._buildFailureAction(error);
    const desiredState = error.nextState || (['execution', 'protection'].includes(error.stage) ? 'degraded' : 'retrying');
    const degradedStartedAt = runtime.context?.degradedStartedAt || now;
    const nextRetryAt = desiredState === 'paused_by_system' ? null : (now + getRetryDelay(nextFailureCount));
    const shouldPause = nextFailureCount >= config.bots.maxConsecutiveFailures
      || (desiredState === 'degraded' && ((now - degradedStartedAt) >= config.bots.maxDegradedMs));

    await this.appendRun('error', action, signal, candle, {
      stage: error.stage || 'runtime',
      message: error.message,
      actionTaken: shouldPause ? 'system_paused' : 'retry_pending',
      consecutiveFailures: nextFailureCount,
    }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
    this.emit('runtime_error', this.bot, error);

    if (shouldPause) {
      this.stopLoop();
      await this.persistRuntime({
        status: 'paused',
        lastError: error.message,
        runtime: {
          ...runtime,
          state: 'paused_by_system',
          consecutiveFailures: nextFailureCount,
          nextRetryAt: null,
          lastRecoveryAt: now,
          lastRecoveryAction: 'system_paused',
          systemPauseReason: error.message,
          context: {
            ...runtime.context,
            degradedStartedAt,
            lastFailureAt: now,
            stage: error.stage || 'runtime',
            message: error.message,
          },
        },
      }).catch((err) => logger.warn('bot persistRuntime failed', { botId: this.bot?.id, error: err.message }));
      await this.appendRun('paused', 'system_paused', signal, candle, {
        stage: error.stage || 'runtime',
        message: error.message,
        actionTaken: 'Bot pausado automaticamente por seguridad',
        consecutiveFailures: nextFailureCount,
      }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
      this.emit('status', this.bot);
      this._emitRuntimeEvent('runtime_paused', {
        stage: error.stage || 'runtime',
        message: error.message,
        actionTaken: 'Bot pausado automaticamente por seguridad',
      });
      return;
    }

    await this.persistRuntime({
      status: 'active',
      lastError: error.message,
      lastEvaluatedAt: now,
      runtime: {
        ...runtime,
        state: desiredState,
        consecutiveFailures: nextFailureCount,
        nextRetryAt,
        lastRecoveryAt: now,
        lastRecoveryAction: action,
        systemPauseReason: null,
        context: {
          ...runtime.context,
          degradedStartedAt: desiredState === 'degraded' ? degradedStartedAt : runtime.context?.degradedStartedAt || null,
          lastFailureAt: now,
          stage: error.stage || 'runtime',
          message: error.message,
        },
      },
    }).catch((err) => logger.warn('bot persistRuntime failed', { botId: this.bot?.id, error: err.message }));
    this._emitRuntimeEvent('runtime_warning', {
      stage: error.stage || 'runtime',
      message: error.message,
      actionTaken: desiredState === 'degraded' ? 'Entrando en modo degradado' : 'Programando reintento',
      nextRetryAt,
    });
    await this.appendRun('warning', 'retry_scheduled', signal, candle, {
      stage: error.stage || 'runtime',
      message: error.message,
      actionTaken: 'Reintento programado',
      nextRetryAt,
      consecutiveFailures: nextFailureCount,
    }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
    this._emitRuntimeEvent('runtime_retry_scheduled', {
      stage: error.stage || 'runtime',
      message: error.message,
      actionTaken: 'Reintento programado',
      nextRetryAt,
    });
  }

  async _markHealthy({ signal, signalHash, latestCandle }) {
    const runtime = this._runtime();
    const hadIncident = runtime.state !== 'healthy'
      || runtime.consecutiveFailures > 0
      || !!this.bot.lastError;
    const recoveryAction = runtime.lastRecoveryAction;

    await this.persistRuntime({
      status: 'active',
      lastCandleAt: latestCandle?.closeTime ?? this.bot.lastCandleAt,
      lastSignalHash: signalHash ?? this.bot.lastSignalHash,
      lastError: null,
      lastEvaluatedAt: Date.now(),
      lastSignal: signal ?? this.bot.lastSignal,
      runtime: {
        ...defaultRuntime(),
        lastRecoveryAt: hadIncident ? Date.now() : runtime.lastRecoveryAt,
        lastRecoveryAction: hadIncident ? 'runtime_recovered' : recoveryAction,
      },
    });

    if (hadIncident) {
      await this.appendRun('recovered', 'runtime_recovered', signal, latestCandle, {
        stage: 'runtime',
        message: 'Bot recuperado y de vuelta en healthy',
        actionTaken: recoveryAction || 'runtime_recovered',
        recoveryResult: 'healthy',
      }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
      this._emitRuntimeEvent('runtime_recovered', {
        stage: 'runtime',
        message: 'Bot recuperado y de vuelta en healthy',
        actionTaken: recoveryAction || 'runtime_recovered',
      });
    }
  }

  async evaluateLatest({ force = false } = {}) {
    if (this.isEvaluating || this.bot.status !== 'active') return null;

    const runtime = this._runtime();
    if (!force && runtime.nextRetryAt && runtime.nextRetryAt > Date.now()) {
      return null;
    }

    this.isEvaluating = true;
    let latestCandle = null;
    let signal = null;
    let signalHash = null;

    try {
      const [botRow, strategyRow, indicatorRows] = await Promise.all([
        botsRepository.getById(this.userId, this.bot.id),
        strategiesRepository.getById(this.userId, this.bot.strategyId),
        strategyIndicatorsRepository.listByUser(this.userId),
      ]);

      if (!botRow || !strategyRow) return null;
      this.bot = { ...this.bot, ...mapBotRow(botRow) };
      if (this.bot.status !== 'active') return null;

      const candles = await this._getCandles(force);
      const closedCandles = candles.filter((item) => item.closeTime < Date.now());
      latestCandle = closedCandles[closedCandles.length - 1];
      if (!latestCandle) {
        throw new RuntimeStageError('market_data', 'No hay velas cerradas disponibles', {
          action: 'market_data_failed',
        });
      }
      if (!force && this.bot.lastCandleAt && latestCandle.closeTime <= this.bot.lastCandleAt) return null;

      const snapshot = await this._getSnapshot(true);
      const position = this._findPosition(snapshot);
      const signalResult = await this._evaluateStrategy(strategyRow, indicatorRows, closedCandles, position);
      signal = normalizeSignal(signalResult.signal);
      signalHash = createHash('sha1')
        .update(JSON.stringify({ signal, candle: latestCandle.closeTime }))
        .digest('hex');

      const execution = await this.applySignal(signal, latestCandle, position);
      await this._markHealthy({ signal, signalHash, latestCandle });
      await this.appendRun('success', execution.action, signal, latestCandle, execution.details);
      this.emit('evaluated', this.bot, {
        candle: latestCandle,
        signal,
        execution,
      });
      return { signal, execution };
    } catch (rawError) {
      const error = rawError instanceof RuntimeStageError
        ? rawError
        : new RuntimeStageError('runtime', normalizeErrorMessage(rawError), { cause: rawError });

      const recoveredExecution = await this._attemptExecutionRecovery({
        ...error,
        signal: error.signal || signal,
        candle: error.candle || latestCandle,
      }).catch((err) => { logger.warn('bot execution recovery failed', { botId: this.bot?.id, error: err.message }); return null; });

      if (recoveredExecution) {
        await this._markHealthy({ signal, signalHash, latestCandle });
        await this.appendRun('success', recoveredExecution.action, signal, latestCandle, {
          ...recoveredExecution.details,
          recoveredFromError: error.message,
        }).catch((err) => logger.warn('bot appendRun failed', { botId: this.bot?.id, error: err.message }));
        this.emit('evaluated', this.bot, {
          candle: latestCandle,
          signal,
          execution: recoveredExecution,
        });
        return { signal, execution: recoveredExecution };
      }

      await this._handleRuntimeFailure(error, { candle: latestCandle, signal });
      return null;
    } finally {
      this.isEvaluating = false;
    }
  }

  async applySignal(signal, candle, position) {
    const normalizedAsset = this.bot.asset;

    if (signal.type === 'hold') {
      return { action: 'hold', details: { reason: 'signal_hold' } };
    }

    const trading = await getTradingService(this.userId, this.bot.accountId);

    if (signal.type === 'close') {
      if (!position) {
        return { action: 'close_skip', details: { reason: 'no_position' } };
      }
      let closeResult;
      try {
        closeResult = await trading.closePosition({ accountId: this.bot.accountId, asset: normalizedAsset });
      } catch (error) {
        throw new RuntimeStageError('execution', error.message, {
          signal,
          candle,
          position,
          action: 'execution_failed',
          desiredSide: null,
          cause: error,
        });
      }
      return {
        action: 'close',
        details: {
          side: position.side,
          closedTrade: this._buildClosedTradeDetails(closeResult, { reason: 'signal_close' }),
        },
      };
    }

    if (position && position.side === signal.type) {
      return { action: 'skip_same_side', details: { side: position.side } };
    }

    let closedTrade = null;
    if (position && position.side !== signal.type) {
      let closeResult;
      try {
        closeResult = await trading.closePosition({ accountId: this.bot.accountId, asset: normalizedAsset });
      } catch (error) {
        throw new RuntimeStageError('execution', error.message, {
          signal,
          candle,
          position,
          action: 'execution_failed',
          desiredSide: signal.type,
          cause: error,
        });
      }
      closedTrade = this._buildClosedTradeDetails(closeResult, { reason: 'signal_reverse' });
    }

    const referencePrice = Number(candle.close);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw new RuntimeStageError('execution', `Precio invalido para ${normalizedAsset}`, {
        signal,
        candle,
        action: 'execution_failed',
        desiredSide: signal.type,
      });
    }

    const sizeUsd = Number(this.bot.sizeUsd ?? this.bot.size) * (
      Number.isFinite(signal.sizeMultiplier) && signal.sizeMultiplier > 0
        ? signal.sizeMultiplier
        : 1
    );
    const size = sizeUsd / referencePrice;

    try {
      await trading.openPosition({
        accountId: this.bot.accountId,
        asset: normalizedAsset,
        side: signal.type,
        size,
        leverage: this.bot.leverage,
        marginMode: this.bot.marginMode,
      });
    } catch (error) {
      throw new RuntimeStageError('execution', error.message, {
        signal,
        candle,
        referencePrice,
        action: 'execution_failed',
        desiredSide: signal.type,
        executionSize: size,
        cause: error,
      });
    }

    if (this.bot.stopLossPct || this.bot.takeProfitPct) {
      const { slPrice, tpPrice } = this._buildProtectionPrices(signal.type, referencePrice);
      try {
        await trading.setSLTP({
          asset: normalizedAsset,
          side: signal.type,
          size,
          slPrice,
          tpPrice,
        });
      } catch (error) {
        throw new RuntimeStageError('protection', error.message, {
          signal,
          candle,
          referencePrice,
          action: 'execution_failed',
          desiredSide: signal.type,
          executionSize: size,
          cause: error,
        });
      }
    }

    return {
      action: signal.type === 'long' ? 'open_long' : 'open_short',
      details: {
        sizeUsd,
        size,
        assetSize: size,
        referencePrice,
        leverage: this.bot.leverage,
        closedTrade,
        reversedFrom: closedTrade?.side || null,
      },
    };
  }
}

module.exports = {
  BotRuntime,
};
