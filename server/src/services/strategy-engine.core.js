const vm = require('node:vm');
const { BUILTIN_INDICATORS } = require('./indicator-library');

const DEFAULT_PRECISION = 8;

function round(value, digits = DEFAULT_PRECISION) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildSignalHelpers() {
  return {
    hold(meta = {}) {
      return { type: 'hold', ...meta };
    },
    long(meta = {}) {
      return { type: 'long', ...meta };
    },
    short(meta = {}) {
      return { type: 'short', ...meta };
    },
    close(meta = {}) {
      return { type: 'close', ...meta };
    },
  };
}

function createContext(extra = {}) {
  return vm.createContext({
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Date,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    ...extra,
  }, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
}

function compileModule(source, { filename, timeout = 1000, extraContext = {} } = {}) {
  const module = { exports: {} };
  const context = createContext({
    module,
    exports: module.exports,
    ...extraContext,
  });
  const wrapped = `(function (module, exports) {\n${source}\n})`;
  const script = new vm.Script(wrapped, { filename });
  const factory = script.runInContext(context, { timeout });
  factory(module, module.exports);
  return module.exports;
}

function compileIndicators(indicators = [], timeout = 1000) {
  const custom = new Map();
  for (const indicator of indicators) {
    const exports = compileModule(indicator.scriptSource, {
      filename: `indicator:${indicator.slug}`,
      timeout,
    });
    if (typeof exports.compute !== 'function') {
      throw new Error(`El indicador ${indicator.slug} debe exportar compute(input, params)`);
    }
    custom.set(indicator.slug, exports.compute);
  }
  return custom;
}

function buildRuntimeContext(baseContext = {}, customIndicators = new Map()) {
  const signal = buildSignalHelpers();
  const indicators = {
    ...BUILTIN_INDICATORS,
    custom(slug, input, params = {}) {
      const compute = customIndicators.get(slug);
      if (!compute) throw new Error(`Indicador custom no encontrado: ${slug}`);
      return compute(clone(input), clone(params));
    },
  };

  return {
    ctx: {
      ...clone(baseContext),
      indicators,
      market: {
        candles({ limit } = {}) {
          if (!limit) return clone(baseContext.market.candles);
          return clone(baseContext.market.candles.slice(-Number(limit)));
        },
        currentCandle() {
          const candles = baseContext.market.candles || [];
          return clone(candles[candles.length - 1] || null);
        },
        lastPrice() {
          const candles = baseContext.market.candles || [];
          return candles.length ? Number(candles[candles.length - 1].close) : null;
        },
      },
      account: {
        ...clone(baseContext.account),
        currentPosition: clone(baseContext.account?.position || null),
        position() {
          return clone(baseContext.account?.position || null);
        },
      },
    },
    signal,
  };
}

function normalizeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePercent(value) {
  const numeric = normalizeNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeRateFromBps(value) {
  const numeric = normalizeNumber(value, 0);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric / 10_000;
}

function applySlippage(rawPrice, side, action, slippageRate) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price)) return null;
  if (!slippageRate) return price;

  if (action === 'open') {
    return side === 'long'
      ? round(price * (1 + slippageRate))
      : round(price * (1 - slippageRate));
  }

  return side === 'long'
    ? round(price * (1 - slippageRate))
    : round(price * (1 + slippageRate));
}

function buildBacktestMetrics(trades = [], equitySeries = [], drawdownSeries = [], candleCount = 0) {
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netPnl = 0;
  let bestTrade = null;
  let worstTrade = null;
  let feePaid = 0;
  let slippagePaid = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let longWins = 0;
  let shortWins = 0;
  let winTotal = 0;
  let lossTotal = 0;
  let barsHeldTotal = 0;

  for (const trade of trades) {
    const pnl = Number(trade.pnl || 0);
    const fees = Number(trade.fees || 0);
    const slippage = Number(trade.slippage || 0);
    const barsHeld = Number(trade.barsHeld || 0);
    netPnl += pnl;
    feePaid += fees;
    slippagePaid += slippage;
    barsHeldTotal += barsHeld;
    if (pnl >= 0) {
      wins += 1;
      grossProfit += pnl;
      winTotal += pnl;
    } else {
      grossLoss += Math.abs(pnl);
      lossTotal += Math.abs(pnl);
    }
    if (trade.side === 'long') {
      longTrades += 1;
      if (pnl >= 0) longWins += 1;
    }
    if (trade.side === 'short') {
      shortTrades += 1;
      if (pnl >= 0) shortWins += 1;
    }
    bestTrade = bestTrade == null ? pnl : Math.max(bestTrade, pnl);
    worstTrade = worstTrade == null ? pnl : Math.min(worstTrade, pnl);
  }

  const maxDrawdown = drawdownSeries.reduce(
    (acc, point) => Math.max(acc, Number(point.value || 0)),
    0
  );

  return {
    trades: trades.length,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    netPnl: round(netPnl, 4) || 0,
    maxDrawdown: round(maxDrawdown, 4) || 0,
    profitFactor: grossLoss === 0 ? round(grossProfit, 4) || 0 : round(grossProfit / grossLoss, 4),
    expectancy: trades.length ? round(netPnl / trades.length, 4) : 0,
    avgTrade: trades.length ? round(netPnl / trades.length, 4) : 0,
    grossProfit: round(grossProfit, 4) || 0,
    grossLoss: round(grossLoss, 4) || 0,
    avgWin: wins ? round(winTotal / wins, 4) : 0,
    avgLoss: trades.length - wins ? round(lossTotal / (trades.length - wins), 4) : 0,
    bestTrade: round(bestTrade ?? 0, 4) || 0,
    worstTrade: round(worstTrade ?? 0, 4) || 0,
    longTrades,
    shortTrades,
    winRateLong: longTrades ? Number(((longWins / longTrades) * 100).toFixed(2)) : 0,
    winRateShort: shortTrades ? Number(((shortWins / shortTrades) * 100).toFixed(2)) : 0,
    feePaid: round(feePaid, 4) || 0,
    slippagePaid: round(slippagePaid, 4) || 0,
    exposurePct: candleCount ? round((barsHeldTotal / candleCount) * 100, 4) || 0 : 0,
    avgBarsInTrade: trades.length ? round(barsHeldTotal / trades.length, 4) : 0,
    endingEquity: equitySeries.length ? round(equitySeries[equitySeries.length - 1].value, 4) || 0 : 0,
  };
}

function signalToSide(type) {
  return type === 'long' || type === 'short' ? type : null;
}

function normalizeOverlayOutput(slug, output, candles) {
  if (!Array.isArray(output)) return [];
  if (!output.length) return [];

  const firstNonNull = output.find((item) => item != null);
  if (firstNonNull == null || typeof firstNonNull === 'number') {
    return [{
      id: `${slug}:value`,
      label: slug,
      points: output.map((value, index) => ({
        time: candles[index]?.closeTime || candles[index]?.time || null,
        value: value == null ? null : Number(value),
      })).filter((item) => item.time != null),
    }];
  }

  if (typeof firstNonNull === 'object') {
    const keys = Object.keys(firstNonNull).filter((key) => Number.isFinite(Number(firstNonNull[key])));
    return keys.map((key) => ({
      id: `${slug}:${key}`,
      label: `${slug} ${key}`,
      points: output.map((value, index) => ({
        time: candles[index]?.closeTime || candles[index]?.time || null,
        value: value?.[key] == null ? null : Number(value[key]),
      })).filter((item) => item.time != null),
    }));
  }

  return [];
}

function buildOverlayResults(candles, overlayRequests, customIndicators) {
  if (!Array.isArray(overlayRequests) || !overlayRequests.length) return [];

  return overlayRequests.map((request, index) => {
    const kind = request?.kind === 'custom' ? 'custom' : 'builtin';
    const slug = String(request?.slug || '').trim();
    if (!slug) {
      return {
        id: `overlay-${index}`,
        kind,
        slug: '',
        pane: request?.pane || 'price',
        series: [],
        error: 'slug requerido',
      };
    }

    try {
      let output;
      if (kind === 'custom') {
        const compute = customIndicators.get(slug);
        if (!compute) throw new Error(`Indicador custom no encontrado: ${slug}`);
        output = compute(clone(candles), clone(request?.params || {}));
      } else {
        const indicator = BUILTIN_INDICATORS[slug];
        if (typeof indicator !== 'function') throw new Error(`Indicador builtin no soportado: ${slug}`);
        output = indicator(clone(candles), clone(request?.params || {}));
      }

      return {
        id: request?.id || `overlay-${index}`,
        kind,
        slug,
        pane: request?.pane || 'price',
        params: clone(request?.params || {}),
        series: normalizeOverlayOutput(slug, output, candles),
      };
    } catch (error) {
      return {
        id: request?.id || `overlay-${index}`,
        kind,
        slug,
        pane: request?.pane || 'price',
        params: clone(request?.params || {}),
        series: [],
        error: error.message,
      };
    }
  });
}

function buildPositionRisk(position, stopLossPct, takeProfitPct) {
  if (!position) return null;
  const entry = Number(position.entryPrice);
  if (!Number.isFinite(entry)) return null;

  const stopPrice = stopLossPct
    ? position.side === 'long'
      ? entry * (1 - (stopLossPct / 100))
      : entry * (1 + (stopLossPct / 100))
    : null;
  const takeProfitPrice = takeProfitPct
    ? position.side === 'long'
      ? entry * (1 + (takeProfitPct / 100))
      : entry * (1 - (takeProfitPct / 100))
    : null;

  return {
    stopPrice: stopPrice == null ? null : round(stopPrice),
    takeProfitPrice: takeProfitPrice == null ? null : round(takeProfitPrice),
  };
}

function resolveRiskExit(position, candle) {
  if (!position || !position.risk) return null;
  const high = Number(candle.high);
  const low = Number(candle.low);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;

  if (position.side === 'long') {
    const stopHit = Number.isFinite(position.risk.stopPrice) && low <= position.risk.stopPrice;
    const takeHit = Number.isFinite(position.risk.takeProfitPrice) && high >= position.risk.takeProfitPrice;
    if (stopHit && takeHit) return { reason: 'stop_loss', rawPrice: position.risk.stopPrice };
    if (stopHit) return { reason: 'stop_loss', rawPrice: position.risk.stopPrice };
    if (takeHit) return { reason: 'take_profit', rawPrice: position.risk.takeProfitPrice };
    return null;
  }

  const stopHit = Number.isFinite(position.risk.stopPrice) && high >= position.risk.stopPrice;
  const takeHit = Number.isFinite(position.risk.takeProfitPrice) && low <= position.risk.takeProfitPrice;
  if (stopHit && takeHit) return { reason: 'stop_loss', rawPrice: position.risk.stopPrice };
  if (stopHit) return { reason: 'stop_loss', rawPrice: position.risk.stopPrice };
  if (takeHit) return { reason: 'take_profit', rawPrice: position.risk.takeProfitPrice };
  return null;
}

function replacePoint(series, point) {
  if (!point) return series;
  if (!series.length || series[series.length - 1].time !== point.time) {
    series.push(point);
    return series;
  }
  series[series.length - 1] = point;
  return series;
}

function estimateOpenEquity(realizedPnl, position, candleClose, feeRate, slippageRate) {
  if (!position) return round(realizedPnl, 4) || 0;

  const exitPrice = applySlippage(candleClose, position.side, 'close', slippageRate);
  const direction = position.side === 'long' ? 1 : -1;
  const gross = (Number(exitPrice) - Number(position.entryPrice)) * direction * Number(position.qty);
  const estimatedExitFee = Number(position.qty) * Number(exitPrice) * feeRate;
  return round(realizedPnl + gross - Number(position.entryFee || 0) - estimatedExitFee, 4) || 0;
}

async function runValidation(payload) {
  const customIndicators = compileIndicators(payload.customIndicators, payload.timeout);
  const { ctx, signal } = buildRuntimeContext(payload.context, customIndicators);
  const exports = compileModule(payload.source, {
    filename: 'strategy:validate',
    timeout: payload.timeout,
    extraContext: { signal },
  });
  if (typeof exports.evaluate !== 'function') {
    throw new Error('La estrategia debe exportar async function evaluate(ctx)');
  }
  const result = await exports.evaluate(ctx);
  return {
    signal: clone(result),
    diagnostics: {
      candles: Array.isArray(payload.context?.market?.candles) ? payload.context.market.candles.length : 0,
      positionSide: payload.context?.account?.position?.side || null,
    },
  };
}

async function runIndicatorValidation(payload) {
  const exports = compileModule(payload.source, {
    filename: `indicator:${payload.slug || 'validate'}`,
    timeout: payload.timeout,
  });
  if (typeof exports.compute !== 'function') {
    throw new Error('El indicador debe exportar function compute(input, params)');
  }
  const output = exports.compute(clone(payload.input), clone(payload.params || {}));
  return { sample: clone(output) };
}

async function runBacktest(payload) {
  const customIndicators = compileIndicators(payload.customIndicators, payload.timeout);
  const { signal } = buildRuntimeContext(payload.baseContext, customIndicators);
  const exports = compileModule(payload.source, {
    filename: 'strategy:backtest',
    timeout: payload.timeout,
    extraContext: { signal },
  });
  if (typeof exports.evaluate !== 'function') {
    throw new Error('La estrategia debe exportar async function evaluate(ctx)');
  }

  const candles = Array.isArray(payload.baseContext?.market?.candles)
    ? payload.baseContext.market.candles
    : [];
  const params = payload.baseContext?.params || {};
  const sizingMode = ['usd', 'qty', 'pct_equity'].includes(payload.sizingMode) ? payload.sizingMode : 'usd';
  const leverage = Math.max(1, normalizeNumber(payload.leverage, 1));
  const marginMode = payload.marginMode === 'isolated' ? 'isolated' : 'cross';
  const sizeUsdBase = Math.max(0, normalizeNumber(payload.sizeUsd, normalizeNumber(params.sizeUsd, normalizeNumber(params.size, 100))));
  const tradeSizeBase = Math.max(0, normalizeNumber(payload.tradeSize, normalizeNumber(params.size, 1)));
  const pctEquity = Math.max(0.1, Math.min(100, normalizeNumber(payload.pctEquity, 10)));
  const stopLossPct = normalizePercent(payload.stopLossPct);
  const takeProfitPct = normalizePercent(payload.takeProfitPct);
  const feeRate = normalizeRateFromBps(payload.feeBps);
  const slippageRate = normalizeRateFromBps(payload.slippageBps);

  const trades = [];
  const signals = [];
  const positionSegments = [];
  const equitySeries = [];
  const drawdownSeries = [];
  let position = null;
  let realizedPnl = 0;
  let peakEquity = 0;

  function openPosition(positionSide, candle, signalMeta = {}) {
    const referencePrice = Number(candle.close);
    const fillPrice = applySlippage(referencePrice, positionSide, 'open', slippageRate);
    const sizeMultiplier = Number(signalMeta.sizeMultiplier);
    const multiplier = Number.isFinite(sizeMultiplier) && sizeMultiplier > 0 ? sizeMultiplier : 1;
    let effectiveSize;
    if (sizingMode === 'pct_equity') {
      const currentEquity = sizeUsdBase + realizedPnl;
      effectiveSize = Math.max(1, currentEquity * (pctEquity / 100)) * multiplier;
    } else {
      effectiveSize = sizeUsdBase * multiplier;
    }
    const qty = sizingMode === 'qty'
      ? tradeSizeBase * multiplier
      : effectiveSize / fillPrice;
    const sizeUsd = qty * fillPrice;
    const entryFee = sizeUsd * feeRate;

    position = {
      side: positionSide,
      entryPrice: fillPrice,
      entryTime: candle.closeTime,
      entryIndex: Number(signalMeta.candleIndex),
      qty: round(qty),
      sizeUsd: round(sizeUsd, 4),
      marginUsed: round(sizeUsd / leverage, 4),
      leverage,
      marginMode,
      entryFee: round(entryFee, 6),
      entrySlippage: round(Math.abs(fillPrice - referencePrice) * qty, 6),
      risk: null,
    };
    position.risk = buildPositionRisk(position, stopLossPct, takeProfitPct);
  }

  function closePosition(reason, rawPrice, candle, extra = {}) {
    if (!position) return null;

    const fillPrice = applySlippage(rawPrice, position.side, 'close', slippageRate);
    const direction = position.side === 'long' ? 1 : -1;
    const grossPnl = (fillPrice - Number(position.entryPrice)) * direction * Number(position.qty);
    const exitNotional = Number(position.qty) * Number(fillPrice);
    const exitFee = exitNotional * feeRate;
    const fees = Number(position.entryFee || 0) + exitFee;
    const pnl = round(grossPnl - fees, 4) || 0;
    realizedPnl += pnl;
    const exitIndex = Number(extra.candleIndex);
    const barsHeld = Math.max(1, (Number.isFinite(exitIndex) ? exitIndex : position.entryIndex) - Number(position.entryIndex) + 1);
    const trade = {
      side: position.side,
      entryPrice: round(position.entryPrice, 6),
      exitPrice: round(fillPrice, 6),
      entryTime: position.entryTime,
      exitTime: candle.closeTime,
      openedAt: position.entryTime,
      closedAt: candle.closeTime,
      qty: round(position.qty, 8),
      sizeUsd: round(position.sizeUsd, 4),
      marginUsed: round(position.marginUsed, 4),
      leverage,
      marginMode,
      reason,
      fees: round(fees, 6) || 0,
      slippage: round(Number(position.entrySlippage || 0) + (Math.abs(fillPrice - Number(rawPrice)) * Number(position.qty)), 6) || 0,
      barsHeld,
      pnl,
      equity: round(realizedPnl, 4) || 0,
      equityAfter: round(realizedPnl, 4) || 0,
      meta: clone(extra.meta || {}),
    };
    trades.push(trade);
    positionSegments.push({
      side: position.side,
      entryTime: position.entryTime,
      exitTime: candle.closeTime,
      entryPrice: round(position.entryPrice, 6),
      exitPrice: round(fillPrice, 6),
      pnl,
      reason,
    });
    position = null;
    return trade;
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];

    if (position && index > position.entryIndex) {
      const riskExit = resolveRiskExit(position, candle);
      if (riskExit) {
        closePosition(riskExit.reason, riskExit.rawPrice, candle, { meta: { kind: 'risk' }, candleIndex: index });
      }
    }

    const slice = candles.slice(0, index + 1);
    const runtime = buildRuntimeContext({
      ...payload.baseContext,
      market: { candles: slice },
      account: { position },
      params,
    }, customIndicators);
    const currentSignal = await exports.evaluate(runtime.ctx) || signal.hold();
    const signalType = signalToSide(currentSignal.type) || (currentSignal.type === 'close' ? 'close' : 'hold');
    const signalMeta = { ...clone(currentSignal), candleIndex: index };
    const signalRow = {
      time: candle.time,
      closeTime: candle.closeTime,
      type: signalType,
      meta: signalMeta,
      action: 'hold',
      price: Number(candle.close),
    };

    if (signalType === 'close') {
      if (position) {
        closePosition('signal_close', candle.close, candle, { meta: signalMeta, candleIndex: index });
        signalRow.action = 'close';
      } else {
        signalRow.action = 'close_skip';
      }
    } else if (signalType === 'long' || signalType === 'short') {
      if (position && position.side === signalType) {
        signalRow.action = 'skip_same_side';
      } else {
        if (position && position.side !== signalType) {
          closePosition('signal_reverse', candle.close, candle, { meta: signalMeta, candleIndex: index });
          signalRow.action = 'reverse';
        } else {
          signalRow.action = signalType === 'long' ? 'open_long' : 'open_short';
        }
        openPosition(signalType, candle, signalMeta);
      }
    }

    signals.push(signalRow);

    const equityValue = estimateOpenEquity(realizedPnl, position, candle.close, feeRate, slippageRate);
    peakEquity = Math.max(peakEquity, equityValue);
    replacePoint(equitySeries, { time: candle.closeTime, value: equityValue });
    replacePoint(drawdownSeries, { time: candle.closeTime, value: round(peakEquity - equityValue, 4) || 0 });
  }

  if (position && candles.length) {
    const lastCandle = candles[candles.length - 1];
    closePosition('end_of_range', lastCandle.close, lastCandle, {
      meta: { kind: 'range_end' },
      candleIndex: candles.length - 1,
    });
    const lastEquity = round(realizedPnl, 4) || 0;
    peakEquity = Math.max(peakEquity, lastEquity);
    replacePoint(equitySeries, { time: lastCandle.closeTime, value: lastEquity });
    replacePoint(drawdownSeries, { time: lastCandle.closeTime, value: round(peakEquity - lastEquity, 4) || 0 });
  }

  const overlays = buildOverlayResults(candles, payload.overlayRequests, customIndicators);

  return {
    metrics: buildBacktestMetrics(trades, equitySeries, drawdownSeries, candles.length),
    candles: clone(candles),
    trades,
    signals,
    positionSegments,
    equitySeries,
    drawdownSeries,
    overlays,
    assumptions: {
      entryMode: 'close_with_slippage',
      stopTpMode: 'intrabar_next_candle',
      sameCandleConflictPolicy: 'stop_first',
    },
  };
}

module.exports = {
  buildRuntimeContext,
  compileIndicators,
  compileModule,
  runBacktest,
  runIndicatorValidation,
  runValidation,
};
