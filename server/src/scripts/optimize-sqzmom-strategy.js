require('dotenv').config();

const db = require('../db');
const marketDataService = require('../services/market-data.service');
const strategyEngine = require('../services/strategy-engine.service');
const indicatorsRepository = require('../repositories/strategy-indicators.repository');
const { mapIndicatorRow } = require('../services/strategies.service');
const logger = require('../services/logger.service');

const STRATEGY_NAME = 'SQZMOM Regime ADX Multi-Asset';
const TEST_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const DEFAULT_TIMEFRAMES = ['1h'];
const CANDLE_LIMIT = Number(process.env.SQZMOM_OPT_LIMIT || 240);
const SIZE_USD = Number(process.env.SQZMOM_OPT_SIZE_USD || 100);
const FEE_BPS = Number(process.env.SQZMOM_OPT_FEE_BPS || 2);
const SLIPPAGE_BPS = Number(process.env.SQZMOM_OPT_SLIPPAGE_BPS || 3);

function average(values) {
  if (!values.length) return 0;
  return values.reduce((acc, current) => acc + Number(current || 0), 0) / values.length;
}

function buildStrategySource() {
  return `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: Number(ctx.params.lookback || 120) });
  const position = ctx.account.position();
  if (!Array.isArray(candles) || candles.length < Math.max(Number(ctx.params.trendPeriod || 89) + 5, 90)) {
    return signal.hold({ meta: { reason: 'not_enough_data' } });
  }

  function round(value) {
    return Number.isFinite(value) ? Number(value.toFixed(8)) : null;
  }

  function computeAdx(input, period) {
    const size = Math.max(2, Number(period || 14));
    const tr = [];
    const plusDm = [];
    const minusDm = [];

    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = index > 0 ? input[index - 1] : null;
      const high = Number(current.high ?? current.h);
      const low = Number(current.low ?? current.l);
      const prevClose = previous ? Number(previous.close ?? previous.c) : null;
      const prevHigh = previous ? Number(previous.high ?? previous.h) : null;
      const prevLow = previous ? Number(previous.low ?? previous.l) : null;

      if (!previous || !Number.isFinite(prevClose) || !Number.isFinite(prevHigh) || !Number.isFinite(prevLow)) {
        tr.push(null);
        plusDm.push(null);
        minusDm.push(null);
        continue;
      }

      const upMove = high - prevHigh;
      const downMove = prevLow - low;
      plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
      tr.push(Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      ));
    }

    const adx = Array(input.length).fill(null);
    let smoothedTr = 0;
    let smoothedPlus = 0;
    let smoothedMinus = 0;
    let dxWindow = [];

    for (let index = 1; index < input.length; index += 1) {
      if (index < size) {
        smoothedTr += Number(tr[index] || 0);
        smoothedPlus += Number(plusDm[index] || 0);
        smoothedMinus += Number(minusDm[index] || 0);
        continue;
      }

      if (index === size) {
        smoothedTr += Number(tr[index] || 0);
        smoothedPlus += Number(plusDm[index] || 0);
        smoothedMinus += Number(minusDm[index] || 0);
      } else {
        smoothedTr = smoothedTr - (smoothedTr / size) + Number(tr[index] || 0);
        smoothedPlus = smoothedPlus - (smoothedPlus / size) + Number(plusDm[index] || 0);
        smoothedMinus = smoothedMinus - (smoothedMinus / size) + Number(minusDm[index] || 0);
      }

      if (!smoothedTr) continue;
      const plusDi = 100 * (smoothedPlus / smoothedTr);
      const minusDi = 100 * (smoothedMinus / smoothedTr);
      const denominator = plusDi + minusDi;
      const dx = denominator ? (100 * Math.abs(plusDi - minusDi) / denominator) : 0;

      if (dxWindow.length < size) {
        dxWindow.push(dx);
        if (dxWindow.length === size) {
          adx[index] = round(dxWindow.reduce((acc, current) => acc + current, 0) / size);
        }
        continue;
      }

      adx[index] = round(((Number(adx[index - 1] || dxWindow[dxWindow.length - 1])) * (size - 1) + dx) / size);
      dxWindow.push(dx);
      if (dxWindow.length > size) dxWindow.shift();
    }

    return adx;
  }

  const sqz = ctx.indicators.custom('sqzmom-lb', candles, {
    bbLength: Number(ctx.params.bbLength || 20),
    bbMult: Number(ctx.params.bbMult || 2),
    kcLength: Number(ctx.params.kcLength || 20),
    kcMult: Number(ctx.params.kcMult || 1.5),
    useTrueRange: true,
  });
  const fast = ctx.indicators.ema(candles, { period: Number(ctx.params.fastPeriod || 12) });
  const slow = ctx.indicators.ema(candles, { period: Number(ctx.params.slowPeriod || 34) });
  const trend = ctx.indicators.ema(candles, { period: Number(ctx.params.trendPeriod || 89) });
  const adx = computeAdx(candles, Number(ctx.params.adxPeriod || 14));

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const lastSqz = sqz[sqz.length - 1] || {};
  const prevSqz = sqz[sqz.length - 2] || {};
  const fastLast = fast[fast.length - 1];
  const slowLast = slow[slow.length - 1];
  const trendLast = trend[trend.length - 1];
  const adxLast = adx[adx.length - 1];
  const close = Number(lastCandle.close);
  const prevClose = Number(prevCandle.close);

  if ([lastSqz.value, prevSqz.value, fastLast, slowLast, trendLast, adxLast, close, prevClose].some((value) => value == null || !Number.isFinite(Number(value)))) {
    return signal.hold({ meta: { reason: 'indicator_not_ready' } });
  }

  const requireRelease = ctx.params.requireRelease !== false;
  const bullishRelease = prevSqz.sqzOn && lastSqz.sqzOff;
  const bearishRelease = prevSqz.sqzOn && lastSqz.sqzOff;
  const bullishMomentum = Number(lastSqz.value) > 0 && Number(lastSqz.value) > Number(prevSqz.value);
  const bearishMomentum = Number(lastSqz.value) < 0 && Number(lastSqz.value) < Number(prevSqz.value);
  const bullishTrend = close > trendLast && fastLast > slowLast;
  const bearishTrend = close < trendLast && fastLast < slowLast;
  const adxReady = adxLast >= Number(ctx.params.adxThreshold || 20);
  const directionMode = String(ctx.params.directionMode || 'both');
  const allowLong = directionMode !== 'short_only';
  const allowShort = directionMode !== 'long_only';

  const longSetup = bullishMomentum && bullishTrend && adxReady && (!requireRelease || bullishRelease);
  const shortSetup = bearishMomentum && bearishTrend && adxReady && (!requireRelease || bearishRelease);

  if (!position && allowLong && longSetup) {
    return signal.long({
      meta: {
        setup: 'sqzmom_adx_long',
        momentum: round(Number(lastSqz.value)),
        adx: round(Number(adxLast)),
      },
    });
  }

  if (!position && allowShort && shortSetup) {
    return signal.short({
      meta: {
        setup: 'sqzmom_adx_short',
        momentum: round(Number(lastSqz.value)),
        adx: round(Number(adxLast)),
      },
    });
  }

  const longExit = Number(lastSqz.value) < Number(ctx.params.exitMomentum || 0)
    || close < fastLast
    || fastLast < slowLast;
  const shortExit = Number(lastSqz.value) > -Number(ctx.params.exitMomentum || 0)
    || close > fastLast
    || fastLast > slowLast;

  if (position?.side === 'long' && longExit) {
    return signal.close({
      meta: {
        exit: 'momentum_or_trend_break',
        momentum: round(Number(lastSqz.value)),
      },
    });
  }

  if (position?.side === 'short' && shortExit) {
    return signal.close({
      meta: {
        exit: 'momentum_or_trend_break',
        momentum: round(Number(lastSqz.value)),
      },
    });
  }

  return signal.hold({
    meta: {
      momentum: round(Number(lastSqz.value)),
      adx: round(Number(adxLast)),
      trendSpread: round(Number(fastLast) - Number(slowLast)),
    },
  });
};`;
}

function buildCandidates() {
  const presets = [
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 25, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'both' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 25, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'long_only' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 20, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'both' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 20, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'long_only' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 25, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.2, takeProfitPct: 4, directionMode: 'both' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 89, adxPeriod: 14, adxThreshold: 25, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.2, takeProfitPct: 4, directionMode: 'long_only' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 55, adxPeriod: 14, adxThreshold: 20, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'both' },
    { lookback: 120, fastPeriod: 21, slowPeriod: 55, trendPeriod: 55, adxPeriod: 14, adxThreshold: 20, requireRelease: true, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 5, directionMode: 'long_only' },
    { lookback: 120, fastPeriod: 12, slowPeriod: 34, trendPeriod: 55, adxPeriod: 14, adxThreshold: 20, requireRelease: false, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 3, directionMode: 'both' },
    { lookback: 120, fastPeriod: 12, slowPeriod: 34, trendPeriod: 55, adxPeriod: 14, adxThreshold: 20, requireRelease: false, exitMomentum: 0.05, bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, stopLossPct: 1.5, takeProfitPct: 3, directionMode: 'long_only' },
  ];
  const candidates = [];
  for (const timeframe of DEFAULT_TIMEFRAMES) {
    for (const preset of presets) {
      candidates.push({
        timeframe,
        ...preset,
      });
    }
  }
  return candidates;
}

async function resolveTargetUser() {
  const preferredUsername = process.env.DEV_ADMIN_USERNAME || 'admin';
  const existing = await db.query(
    'SELECT id, username, name FROM users WHERE username = $1 LIMIT 1',
    [preferredUsername]
  );
  if (existing.rows[0]) return existing.rows[0];
  throw new Error(`Usuario no encontrado: ${preferredUsername}`);
}

async function loadCustomIndicators(userId) {
  const rows = await indicatorsRepository.listByUser(userId);
  return rows.map(mapIndicatorRow);
}

function buildScore(summary) {
  return Number((summary.avgNetPnl - (summary.avgMaxDrawdown * 0.25)).toFixed(4));
}

async function simulateForAsset({ asset, timeframe, params, source, customIndicators }) {
  const candles = await marketDataService.getCandles(asset, timeframe, {
    limit: CANDLE_LIMIT,
    force: true,
  });

  const result = await strategyEngine.simulateBacktest({
    source,
    baseContext: {
      market: { candles },
      account: { position: null },
      params,
    },
    customIndicators,
    sizingMode: 'usd',
    sizeUsd: SIZE_USD,
    leverage: 5,
    marginMode: 'cross',
    stopLossPct: params.stopLossPct,
    takeProfitPct: params.takeProfitPct,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    overlayRequests: [],
  });

  return {
    asset,
    metrics: result.metrics,
    trades: result.trades.length,
  };
}

async function evaluateCandidate({ source, customIndicators, candidate }) {
  const assetResults = [];
  for (const asset of TEST_ASSETS) {
    const result = await simulateForAsset({
      asset,
      timeframe: candidate.timeframe,
      params: candidate,
      source,
      customIndicators,
    });
    assetResults.push(result);
  }

  const avgNetPnl = average(assetResults.map((item) => item.metrics.netPnl));
  const avgMaxDrawdown = average(assetResults.map((item) => item.metrics.maxDrawdown));
  const avgProfitFactor = average(assetResults.map((item) => item.metrics.profitFactor));
  const avgWinRate = average(assetResults.map((item) => item.metrics.winRate));
  const avgTrades = average(assetResults.map((item) => item.metrics.trades));
  const positiveAssets = assetResults.filter((item) => Number(item.metrics.netPnl) > 0).length;

  const summary = {
    ...candidate,
    avgNetPnl: Number(avgNetPnl.toFixed(4)),
    avgMaxDrawdown: Number(avgMaxDrawdown.toFixed(4)),
    avgProfitFactor: Number(avgProfitFactor.toFixed(4)),
    avgWinRate: Number(avgWinRate.toFixed(2)),
    avgTrades: Number(avgTrades.toFixed(2)),
    positiveAssets,
    score: 0,
    assetResults: assetResults.map((item) => ({
      asset: item.asset,
      netPnl: item.metrics.netPnl,
      maxDrawdown: item.metrics.maxDrawdown,
      profitFactor: item.metrics.profitFactor,
      trades: item.metrics.trades,
      winRate: item.metrics.winRate,
    })),
  };
  summary.score = buildScore(summary);
  return summary;
}

function formatSummary(summary) {
  return {
    timeframe: summary.timeframe,
    fast: summary.fastPeriod,
    slow: summary.slowPeriod,
    trend: summary.trendPeriod,
    adx: summary.adxThreshold,
    direction: summary.directionMode,
    release: summary.requireRelease,
    sl: summary.stopLossPct,
    tp: summary.takeProfitPct,
    avgNetPnl: summary.avgNetPnl,
    avgMaxDD: summary.avgMaxDrawdown,
    avgPF: summary.avgProfitFactor,
    avgTrades: summary.avgTrades,
    positiveAssets: summary.positiveAssets,
    score: summary.score,
  };
}

async function upsertStrategy(userId, source, best) {
  const now = Date.now();
  const description = [
    'Estrategia optimizada por consola sobre 5 activos con SQZMOM_LB + ADX + EMA.',
    `Activos test: ${TEST_ASSETS.join(', ')}`,
    `Timeframe ganador: ${best.timeframe}`,
    `Media netPnl: ${best.avgNetPnl} USD por ${SIZE_USD} USD nocionales`,
    `PF medio: ${best.avgProfitFactor} | DD medio: ${best.avgMaxDrawdown}`,
  ].join(' ');

  const payload = {
    name: STRATEGY_NAME,
    description,
    assetUniverseJson: JSON.stringify(TEST_ASSETS),
    timeframe: best.timeframe,
    scriptSource: source,
    defaultParamsJson: JSON.stringify({
      fastPeriod: best.fastPeriod,
      slowPeriod: best.slowPeriod,
      lookback: best.lookback,
      trendPeriod: best.trendPeriod,
      adxPeriod: best.adxPeriod,
      adxThreshold: best.adxThreshold,
      directionMode: best.directionMode,
      requireRelease: best.requireRelease,
      exitMomentum: best.exitMomentum,
      bbLength: best.bbLength,
      bbMult: best.bbMult,
      kcLength: best.kcLength,
      kcMult: best.kcMult,
      stopLossPct: best.stopLossPct,
      takeProfitPct: best.takeProfitPct,
      sizeUsd: SIZE_USD,
    }),
    isActiveDraft: true,
    now,
  };

  const existing = await db.query(
    'SELECT id FROM strategies WHERE user_id = $1 AND name = $2 LIMIT 1',
    [userId, STRATEGY_NAME]
  );

  if (existing.rows[0]) {
    const { rows } = await db.query(
      `UPDATE strategies
          SET description = $3,
              asset_universe_json = $4,
              timeframe = $5,
              script_source = $6,
              default_params_json = $7,
              is_active_draft = $8,
              updated_at = $9
        WHERE user_id = $1 AND id = $2
        RETURNING id, name`,
      [
        userId,
        existing.rows[0].id,
        payload.description,
        payload.assetUniverseJson,
        payload.timeframe,
        payload.scriptSource,
        payload.defaultParamsJson,
        payload.isActiveDraft,
        payload.now,
      ]
    );
    return { created: false, strategy: rows[0] };
  }

  const { rows } = await db.query(
    `INSERT INTO strategies (
       user_id, name, description, asset_universe_json, timeframe, script_source,
       default_params_json, is_active_draft, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING id, name`,
    [
      userId,
      payload.name,
      payload.description,
      payload.assetUniverseJson,
      payload.timeframe,
      payload.scriptSource,
      payload.defaultParamsJson,
      payload.isActiveDraft,
      payload.now,
    ]
  );
  return { created: true, strategy: rows[0] };
}

async function main() {
  const shouldSave = process.argv.includes('--save');

  await db.ensureConnection();
  await db.initSchema();

  const user = await resolveTargetUser();
  const customIndicators = await loadCustomIndicators(user.id);
  const sqzmom = customIndicators.find((item) => item.slug === 'sqzmom-lb');
  if (!sqzmom) throw new Error('No se encontró el indicador sqzmom-lb para el usuario objetivo');

  const source = buildStrategySource();
  const candidates = buildCandidates();
  const results = [];

  logger.info('sqzmom_optimization_started', {
    userId: user.id,
    username: user.username,
    assets: TEST_ASSETS,
    candidates: candidates.length,
    candleLimit: CANDLE_LIMIT,
  });

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const summary = await evaluateCandidate({
      source,
      customIndicators,
      candidate,
    });
    results.push(summary);
    console.log(JSON.stringify({
      step: index + 1,
      total: candidates.length,
      ...formatSummary(summary),
    }));
  }

  results.sort((a, b) => {
    if (b.avgNetPnl !== a.avgNetPnl) return b.avgNetPnl - a.avgNetPnl;
    if (b.positiveAssets !== a.positiveAssets) return b.positiveAssets - a.positiveAssets;
    if (b.avgProfitFactor !== a.avgProfitFactor) return b.avgProfitFactor - a.avgProfitFactor;
    return a.avgMaxDrawdown - b.avgMaxDrawdown;
  });

  const best = results[0];
  console.log('TOP_5_RESULTS');
  results.slice(0, 5).forEach((item, index) => {
    console.log(JSON.stringify({ rank: index + 1, ...formatSummary(item), assetResults: item.assetResults }));
  });

  if (shouldSave) {
    const saved = await upsertStrategy(user.id, source, best);
    console.log(JSON.stringify({
      saved: true,
      created: saved.created,
      strategyId: saved.strategy.id,
      strategyName: saved.strategy.name,
      best: formatSummary(best),
    }));
  } else {
    console.log(JSON.stringify({ saved: false, best: formatSummary(best) }));
  }

  await db.pool.end();
}

main().catch(async (error) => {
  logger.error('sqzmom_optimization_failed', { error: error.message, stack: error.stack });
  await db.pool.end().catch(() => {});
  process.exit(1);
});
