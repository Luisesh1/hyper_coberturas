require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');

const INDICATOR_NAME = 'Squeeze Momentum Indicator [LazyBear]';
const INDICATOR_SLUG = 'sqzmom-lb';
const INDICATOR_SOURCE = `module.exports.compute = function compute(input, params = {}) {
  if (!Array.isArray(input) || input.length === 0) return [];

  const bbLength = Math.max(1, Number(params.bbLength || params.length || 20));
  const bbMult = Number(params.bbMult || params.mult || 2.0);
  const kcLength = Math.max(1, Number(params.kcLength || params.lengthKC || 20));
  const kcMult = Number(params.kcMult || params.multKC || 1.5);
  const useTrueRange = params.useTrueRange !== false;

  const round = (value) => Number.isFinite(value) ? Number(value.toFixed(8)) : null;
  const close = input.map((item) => Number(item.close ?? item.c));
  const high = input.map((item) => Number(item.high ?? item.h));
  const low = input.map((item) => Number(item.low ?? item.l));

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
    const meanSeries = smaSeries(series, length);
    return series.map((_value, index) => {
      const values = windowAt(series, index, length);
      const mean = meanSeries[index];
      if (!values || !Number.isFinite(mean)) return null;
      const variance = values.reduce((acc, current) => acc + ((current - mean) ** 2), 0) / length;
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

  function trueRangeSeries() {
    return input.map((candle, index) => {
      const currentHigh = Number(candle.high ?? candle.h);
      const currentLow = Number(candle.low ?? candle.l);
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

  const basis = smaSeries(close, bbLength);
  const dev = stdevSeries(close, bbLength).map((value) => (value == null ? null : round(value * bbMult)));
  const upperBB = basis.map((value, index) => (value == null || dev[index] == null ? null : round(value + dev[index])));
  const lowerBB = basis.map((value, index) => (value == null || dev[index] == null ? null : round(value - dev[index])));

  const ma = smaSeries(close, kcLength);
  const rangeSeries = useTrueRange
    ? trueRangeSeries()
    : high.map((value, index) => (Number.isFinite(value) && Number.isFinite(low[index]) ? round(value - low[index]) : null));
  const rangeMa = smaSeries(rangeSeries, kcLength);
  const upperKC = ma.map((value, index) => (value == null || rangeMa[index] == null ? null : round(value + (rangeMa[index] * kcMult))));
  const lowerKC = ma.map((value, index) => (value == null || rangeMa[index] == null ? null : round(value - (rangeMa[index] * kcMult))));

  const highestHigh = highestSeries(high, kcLength);
  const lowestLow = lowestSeries(low, kcLength);
  const smaCloseKC = smaSeries(close, kcLength);

  return input.map((candle, index) => {
    const squeezeOn = lowerBB[index] != null && lowerKC[index] != null && upperBB[index] != null && upperKC[index] != null
      ? lowerBB[index] > lowerKC[index] && upperBB[index] < upperKC[index]
      : false;
    const squeezeOff = lowerBB[index] != null && lowerKC[index] != null && upperBB[index] != null && upperKC[index] != null
      ? lowerBB[index] < lowerKC[index] && upperBB[index] > upperKC[index]
      : false;
    const noSqueeze = !squeezeOn && !squeezeOff;

    const mean = highestHigh[index] != null && lowestLow[index] != null && smaCloseKC[index] != null
      ? (((highestHigh[index] + lowestLow[index]) / 2) + smaCloseKC[index]) / 2
      : null;
    const detrended = mean != null && Number.isFinite(close[index]) ? round(close[index] - mean) : null;
    const detrendedSeries = close.map((_value, innerIndex) => (
      innerIndex === index ? detrended : null
    ));

    const valuesForLinreg = input.map((_item, innerIndex) => {
      if (innerIndex > index) return null;
      const innerMean = highestHigh[innerIndex] != null && lowestLow[innerIndex] != null && smaCloseKC[innerIndex] != null
        ? (((highestHigh[innerIndex] + lowestLow[innerIndex]) / 2) + smaCloseKC[innerIndex]) / 2
        : null;
      return innerMean != null && Number.isFinite(close[innerIndex])
        ? round(close[innerIndex] - innerMean)
        : null;
    });
    const momentum = linregLast(valuesForLinreg, kcLength, index);
    const prevMomentum = index > 0 ? linregLast(valuesForLinreg, kcLength, index - 1) : null;

    let barColor = 'gray';
    if (momentum != null && momentum > 0) {
      barColor = prevMomentum != null && momentum > prevMomentum ? 'lime' : 'green';
    } else if (momentum != null && momentum < 0) {
      barColor = prevMomentum != null && momentum < prevMomentum ? 'red' : 'maroon';
    }

    const squeezeColor = noSqueeze ? 'blue' : squeezeOn ? 'black' : 'gray';

    return {
      time: Number(candle.time ?? candle.t ?? index),
      value: momentum,
      histogram: momentum,
      sqzOn: squeezeOn,
      sqzOff: squeezeOff,
      noSqz: noSqueeze,
      barColor,
      squeezeColor,
      upperBB: upperBB[index],
      lowerBB: lowerBB[index],
      upperKC: upperKC[index],
      lowerKC: lowerKC[index],
    };
  });
};`;

function getParameterSchema() {
  return {
    type: 'object',
    defaults: {
      bbLength: 20,
      bbMult: 2,
      kcLength: 20,
      kcMult: 1.5,
      useTrueRange: true,
    },
    fields: {
      bbLength: { type: 'number', min: 1, label: 'BB Length' },
      bbMult: { type: 'number', min: 0.1, label: 'BB MultFactor' },
      kcLength: { type: 'number', min: 1, label: 'KC Length' },
      kcMult: { type: 'number', min: 0.1, label: 'KC MultFactor' },
      useTrueRange: { type: 'boolean', label: 'Use TrueRange (KC)' },
    },
    output: {
      type: 'series<object>',
      fields: ['value', 'histogram', 'sqzOn', 'sqzOff', 'noSqz', 'barColor', 'squeezeColor'],
    },
    notes: [
      'Port de Pine Script a JavaScript para el runtime del bot.',
      'Devuelve una serie con momentum e informacion de squeeze por vela.',
    ],
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

async function upsertIndicator(userId) {
  const now = Date.now();
  const existing = await db.query(
    'SELECT id FROM strategy_indicators WHERE user_id = $1 AND slug = $2 LIMIT 1',
    [userId, INDICATOR_SLUG]
  );

  if (existing.rows[0]) {
    const { rows } = await db.query(
      `UPDATE strategy_indicators
          SET name = $3,
              script_source = $4,
              parameter_schema_json = $5,
              updated_at = $6
        WHERE id = $1 AND user_id = $2
        RETURNING id, slug, updated_at`,
      [
        existing.rows[0].id,
        userId,
        INDICATOR_NAME,
        INDICATOR_SOURCE,
        JSON.stringify(getParameterSchema()),
        now,
      ]
    );
    return { created: false, indicator: rows[0] };
  }

  const { rows } = await db.query(
    `INSERT INTO strategy_indicators (
       user_id, name, slug, script_source, parameter_schema_json, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id, slug, created_at`,
    [
      userId,
      INDICATOR_NAME,
      INDICATOR_SLUG,
      INDICATOR_SOURCE,
      JSON.stringify(getParameterSchema()),
      now,
    ]
  );

  return { created: true, indicator: rows[0] };
}

async function main() {
  await db.ensureConnection();
  await db.initSchema();

  const user = await resolveTargetUser();
  const result = await upsertIndicator(user.id);

  logger.info('seed_sqzmom_lb_indicator_completed', {
    created: result.created,
    indicatorId: result.indicator.id,
    userId: user.id,
    username: user.username,
    slug: INDICATOR_SLUG,
  });

  await db.pool.end();
}

main().catch(async (err) => {
  logger.error('seed_sqzmom_lb_indicator_failed', { error: err.message, stack: err.stack });
  await db.pool.end().catch(() => {});
  process.exit(1);
});
