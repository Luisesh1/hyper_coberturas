require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');

const STRATEGY_NAME = 'SQZMOM Strategy EMA55';
const STRATEGY_DESCRIPTION = 'Port de Pine Script SQZMOM con filtro EMA, entradas anticipadas por pendiente/cruce y salidas por validacion contra media del histograma. Es agnostica a asset y temporalidad: el bot/backtest define el mercado y la estrategia recibe parametros ajustables.';

const STRATEGY_SOURCE = `module.exports.evaluate = async function evaluate(ctx) {
  const lengthBB = Math.max(1, Number(ctx.params.lengthBB || 20));
  const multBB = Number(ctx.params.multBB || 2.0);
  const lengthKC = Math.max(1, Number(ctx.params.lengthKC || 20));
  const multKC = Number(ctx.params.multKC || 1.5);
  const useTrueRange = ctx.params.useTrueRange !== false;
  const enableLong = ctx.params.enableLong !== false;
  const enableShort = ctx.params.enableShort !== false;
  const useFullEquity = ctx.params.useFullEquity === true;
  const enableScaleOut = ctx.params.enableScaleOut === true;
  const emaLen = Math.max(1, Number(ctx.params.emaLen || 55));
  const periodNR = Math.max(10, Number(ctx.params.periodNR || 100));
  const atrPeriod = Math.max(1, Number(ctx.params.atrPeriod || 3));
  const atrScale = Number(ctx.params.atrScale || 1.0);
  const lookback = Math.max(lengthBB, (lengthKC * 2) + periodNR + 5, emaLen + 4, atrPeriod + 4);
  const candles = ctx.market.candles({ limit: lookback });
  const position = ctx.account.position();

  if (!Array.isArray(candles) || candles.length < Math.max(lengthKC * 2, periodNR, emaLen) + 3) {
    return signal.hold({ meta: { reason: 'not_enough_data' } });
  }

  function round(value) {
    return Number.isFinite(value) ? Number(value.toFixed(8)) : null;
  }

  function valueOf(candle, field) {
    if (!candle) return null;
    if (field === 'high') return Number(candle.high ?? candle.h);
    if (field === 'low') return Number(candle.low ?? candle.l);
    return Number(candle.close ?? candle.c);
  }

  function windowAt(series, index, length) {
    if (index < length - 1) return null;
    const values = series.slice(index - length + 1, index + 1);
    return values.every((value) => Number.isFinite(value)) ? values : null;
  }

  function smaSeries(series, length) {
    return series.map((_value, index) => {
      const values = windowAt(series, index, length);
      if (!values) return null;
      return round(values.reduce((acc, current) => acc + current, 0) / length);
    });
  }

  function stdevSeries(series, length) {
    const mean = smaSeries(series, length);
    return series.map((_value, index) => {
      const values = windowAt(series, index, length);
      if (!values || !Number.isFinite(mean[index])) return null;
      const variance = values.reduce((acc, current) => acc + ((current - mean[index]) ** 2), 0) / length;
      return round(Math.sqrt(variance));
    });
  }

  function highestSeries(series, length) {
    return series.map((_value, index) => {
      const values = windowAt(series, index, length);
      return values ? round(Math.max(...values)) : null;
    });
  }

  function lowestSeries(series, length) {
    return series.map((_value, index) => {
      const values = windowAt(series, index, length);
      return values ? round(Math.min(...values)) : null;
    });
  }

  function emaSeries(series, length) {
    const multiplier = 2 / (length + 1);
    let previous = null;
    return series.map((value, index) => {
      if (!Number.isFinite(value)) return null;
      if (index < length - 1) return null;
      if (index === length - 1) {
        const values = windowAt(series, index, length);
        if (!values) return null;
        previous = values.reduce((acc, current) => acc + current, 0) / length;
        return round(previous);
      }
      previous = ((value - previous) * multiplier) + previous;
      return round(previous);
    });
  }

  function trueRangeSeries(high, low, close) {
    return high.map((currentHigh, index) => {
      const currentLow = low[index];
      const prevClose = index > 0 ? close[index - 1] : null;
      if (!Number.isFinite(currentHigh) || !Number.isFinite(currentLow)) return null;
      if (!Number.isFinite(prevClose)) return round(currentHigh - currentLow);
      return round(Math.max(
        currentHigh - currentLow,
        Math.abs(currentHigh - prevClose),
        Math.abs(currentLow - prevClose)
      ));
    });
  }

  function atrSeries(high, low, close, length) {
    const tr = trueRangeSeries(high, low, close);
    const result = Array(tr.length).fill(null);
    let previous = null;
    for (let index = 0; index < tr.length; index += 1) {
      if (!Number.isFinite(tr[index])) continue;
      if (index < length - 1) continue;
      if (index === length - 1) {
        const values = windowAt(tr, index, length);
        if (!values) continue;
        previous = values.reduce((acc, current) => acc + current, 0) / length;
        result[index] = round(previous);
        continue;
      }
      previous = ((previous * (length - 1)) + tr[index]) / length;
      result[index] = round(previous);
    }
    return result;
  }

  function linregLast(series, length, index) {
    const values = windowAt(series, index, length);
    if (!values) return null;
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((acc, current) => acc + current, 0) / n;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i += 1) {
      numerator += (i - xMean) * (values[i] - yMean);
      denominator += (i - xMean) ** 2;
    }
    if (!denominator) return round(values[n - 1]);
    const slope = numerator / denominator;
    const intercept = yMean - (slope * xMean);
    return round(intercept + (slope * (n - 1)));
  }

  const close = candles.map((item) => valueOf(item, 'close'));
  const high = candles.map((item) => valueOf(item, 'high'));
  const low = candles.map((item) => valueOf(item, 'low'));
  // Las bandas BB/KC del Pine original solo afectan plots de squeeze. Las reglas
  // de trading usan el histograma, su media, pendiente, EMA y ATR.
  const highestHigh = highestSeries(high, lengthKC);
  const lowestLow = lowestSeries(low, lengthKC);
  const smaCloseKC = smaSeries(close, lengthKC);
  const detrended = close.map((value, index) => {
    const mean = highestHigh[index] != null && lowestLow[index] != null && smaCloseKC[index] != null
      ? (((highestHigh[index] + lowestLow[index]) / 2) + smaCloseKC[index]) / 2
      : null;
    return mean != null && Number.isFinite(value) ? round(value - mean) : null;
  });
  const val = close.map((_value, index) => linregLast(detrended, lengthKC, index));
  const meanVal = smaSeries(val, periodNR);
  const emaFilter = emaSeries(close, emaLen);
  const atr = atrSeries(high, low, close, atrPeriod);
  const lastIndex = candles.length - 1;
  const prevIndex = candles.length - 2;
  const lastVal = val[lastIndex];
  const prevVal = val[prevIndex];
  const lastMean = meanVal[lastIndex];
  const prevMean = meanVal[prevIndex];
  const lastClose = close[lastIndex];
  const trend = emaFilter[lastIndex];
  const lastAtr = atr[lastIndex] != null ? atr[lastIndex] * atrScale : null;

  if ([lastVal, prevVal, lastMean, prevMean, lastClose, trend].some((value) => value == null || !Number.isFinite(Number(value)))) {
    return signal.hold({ meta: { reason: 'indicator_not_ready' } });
  }

  const slope = lastVal - prevVal;
  const prevSlope = prevIndex > 0 && val[prevIndex - 1] != null ? prevVal - val[prevIndex - 1] : null;
  const crossUp = prevVal <= prevMean && lastVal > lastMean;
  const crossDown = prevVal >= prevMean && lastVal < lastMean;
  const dirUp = Number.isFinite(prevSlope) && prevSlope <= 0 && slope > 0;
  const dirDown = Number.isFinite(prevSlope) && prevSlope >= 0 && slope < 0;
  const canLong = enableLong && lastClose > trend;
  const canShort = enableShort && lastClose < trend;
  const metaBase = {
    sqzmom: round(lastVal),
    mean: round(lastMean),
    ema55: round(trend),
    atrTargetDistance: round(lastAtr),
    useFullEquity,
    enableScaleOut,
    plotParams: { lengthBB, multBB, multKC, useTrueRange },
  };

  function findEntryIndex() {
    if (!position) return null;
    const ago = Number(position.entryBarsAgo);
    if (Number.isFinite(ago) && ago >= 0) {
      return Math.max(0, candles.length - 1 - Math.floor(ago));
    }
    const entryTime = Number(position.entryTime ?? position.openedAt ?? position.openTime ?? position.time);
    if (Number.isFinite(entryTime)) {
      const exact = candles.findIndex((item) => Number(item.closeTime ?? item.time) >= entryTime);
      if (exact >= 0) return exact;
    }
    return Math.max(0, candles.length - 80);
  }

  function crossedSinceEntry(direction) {
    const entryIndex = findEntryIndex();
    if (entryIndex == null) return false;
    for (let index = Math.max(entryIndex + 1, 1); index <= lastIndex; index += 1) {
      if (val[index - 1] == null || meanVal[index - 1] == null || val[index] == null || meanVal[index] == null) continue;
      if (direction === 'up' && val[index - 1] <= meanVal[index - 1] && val[index] > meanVal[index]) return true;
      if (direction === 'down' && val[index - 1] >= meanVal[index - 1] && val[index] < meanVal[index]) return true;
    }
    return direction === 'up' ? lastVal >= lastMean : lastVal <= lastMean;
  }

  function entryWasAnticipated(direction) {
    const entryIndex = findEntryIndex();
    if (entryIndex == null) return false;
    const entryVal = val[entryIndex];
    const entryMean = meanVal[entryIndex];
    if (entryVal == null || entryMean == null) return false;
    return direction === 'long' ? entryVal < entryMean : entryVal > entryMean;
  }

  if (position?.side === 'long') {
    const validated = crossedSinceEntry('up');
    if (entryWasAnticipated('long') && !validated && dirDown) {
      return signal.close({ meta: { ...metaBase, exit: 'early_dir_down_before_mean' } });
    }
    if (validated && crossDown) {
      return signal.close({ meta: { ...metaBase, exit: 'mean_cross_down' } });
    }
    return signal.hold({ meta: metaBase });
  }

  if (position?.side === 'short') {
    const validated = crossedSinceEntry('down');
    if (entryWasAnticipated('short') && !validated && dirUp) {
      return signal.close({ meta: { ...metaBase, exit: 'early_dir_up_before_mean' } });
    }
    if (validated && crossUp) {
      return signal.close({ meta: { ...metaBase, exit: 'mean_cross_up' } });
    }
    return signal.hold({ meta: metaBase });
  }

  if ((crossUp || dirUp) && canLong) {
    return signal.long({
      meta: {
        ...metaBase,
        setup: crossUp ? 'sqzmom_cross_up_ema55' : 'sqzmom_dir_up_ema55',
        entryBelowMean: lastVal < lastMean,
        partialTarget: enableScaleOut && lastAtr != null ? round(lastClose + lastAtr) : null,
        breakEvenAfterPartial: enableScaleOut,
      },
    });
  }

  if ((crossDown || dirDown) && canShort) {
    return signal.short({
      meta: {
        ...metaBase,
        setup: crossDown ? 'sqzmom_cross_down_ema55' : 'sqzmom_dir_down_ema55',
        entryAboveMean: lastVal > lastMean,
        partialTarget: enableScaleOut && lastAtr != null ? round(lastClose - lastAtr) : null,
        breakEvenAfterPartial: enableScaleOut,
      },
    });
  }

  return signal.hold({ meta: metaBase });
};`;

function getDefaultParams() {
  return {
    lengthBB: 20,
    multBB: 2,
    lengthKC: 20,
    multKC: 1.5,
    useTrueRange: true,
    enableLong: true,
    enableShort: true,
    useFullEquity: true,
    enableScaleOut: true,
    emaLen: 55,
    periodNR: 45,
    atrPeriod: 3,
    atrScale: 1,
    sizeUsd: 10000,
    feeBps: 5,
    slippageBps: 0,
  };
}

async function resolveTargetUser() {
  const preferredUsername = process.env.DEV_ADMIN_USERNAME || 'admin';
  const existing = await db.query(
    'SELECT id, username, name FROM users WHERE username = $1 LIMIT 1',
    [preferredUsername]
  );
  if (existing.rows[0]) return existing.rows[0];

  const firstUser = await db.query(
    'SELECT id, username, name FROM users ORDER BY id ASC LIMIT 1'
  );
  if (firstUser.rows[0]) return firstUser.rows[0];

  const seeded = await db.seedDevAdmin({
    username: preferredUsername,
    password: process.env.DEV_ADMIN_PASSWORD || 'admin123',
    name: process.env.DEV_ADMIN_NAME || 'Administrador',
  });
  const created = await db.query(
    'SELECT id, username, name FROM users WHERE id = $1 LIMIT 1',
    [seeded.id]
  );
  return created.rows[0];
}

async function upsertStrategy(userId) {
  const now = Date.now();
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
              is_active_draft = true,
              updated_at = $8
        WHERE id = $1 AND user_id = $2
        RETURNING id, name, updated_at`,
      [
        existing.rows[0].id,
        userId,
        STRATEGY_DESCRIPTION,
        JSON.stringify(['*']),
        '15m',
        STRATEGY_SOURCE,
        JSON.stringify(getDefaultParams()),
        now,
      ]
    );
    return { created: false, strategy: rows[0] };
  }

  const { rows } = await db.query(
    `INSERT INTO strategies (
       user_id, name, description, asset_universe_json, timeframe, script_source,
       default_params_json, is_active_draft, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
     RETURNING id, name, created_at`,
    [
      userId,
      STRATEGY_NAME,
      STRATEGY_DESCRIPTION,
      JSON.stringify(['*']),
      '15m',
      STRATEGY_SOURCE,
      JSON.stringify(getDefaultParams()),
      now,
    ]
  );

  return { created: true, strategy: rows[0] };
}

async function main() {
  await db.ensureConnection();
  await db.initSchema();

  const user = await resolveTargetUser();
  const result = await upsertStrategy(user.id);

  logger.info('seed_sqzmom_ema55_strategy_completed', {
    created: result.created,
    strategyId: result.strategy.id,
    userId: user.id,
    username: user.username,
    strategyName: STRATEGY_NAME,
  });

  await db.pool.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error('seed_sqzmom_ema55_strategy_failed', { error: err.message, stack: err.stack });
    await db.pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  STRATEGY_SOURCE,
  getDefaultParams,
};
