require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');

const STRATEGY_NAME = 'Cruce de Medias Moviles';
const STRATEGY_SOURCE = `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 200 });
  const position = ctx.account.position();
  const indicatorName = ctx.params.indicator === 'sma' ? 'sma' : 'ema';
  const indicatorFn = ctx.indicators[indicatorName];
  const fastPeriod = Number(ctx.params.fastPeriod || 9);
  const slowPeriod = Number(ctx.params.slowPeriod || 21);

  const fastSeries = indicatorFn(candles, { period: fastPeriod });
  const slowSeries = indicatorFn(candles, { period: slowPeriod });
  const lastFast = fastSeries[fastSeries.length - 1];
  const lastSlow = slowSeries[slowSeries.length - 1];
  const prevFast = fastSeries[fastSeries.length - 2];
  const prevSlow = slowSeries[slowSeries.length - 2];

  if ([prevFast, prevSlow, lastFast, lastSlow].some((value) => value == null)) {
    return signal.hold({ meta: { reason: 'not_enough_data' } });
  }

  const bullishCross = prevFast <= prevSlow && lastFast > lastSlow;
  const bearishCross = prevFast >= prevSlow && lastFast < lastSlow;

  if (!position && bullishCross) {
    return signal.long({
      meta: {
        setup: 'ma_cross',
        bias: 'bullish',
        indicator: indicatorName,
      },
    });
  }

  if (!position && bearishCross) {
    return signal.short({
      meta: {
        setup: 'ma_cross',
        bias: 'bearish',
        indicator: indicatorName,
      },
    });
  }

  if (position?.side === 'long' && bearishCross) {
    return signal.close({
      meta: {
        exit: 'cross_down',
        indicator: indicatorName,
      },
    });
  }

  if (position?.side === 'short' && bullishCross) {
    return signal.close({
      meta: {
        exit: 'cross_up',
        indicator: indicatorName,
      },
    });
  }

  return signal.hold({
    meta: {
      indicator: indicatorName,
      spread: Number((lastFast - lastSlow).toFixed(6)),
    },
  });
};`;

function getDefaultParams() {
  return {
    indicator: 'ema',
    fastPeriod: 9,
    slowPeriod: 21,
    size: 0.01,
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
        'Estrategia de ejemplo para probar el modulo de estrategias con cruce de medias moviles rapida/lenta.',
        JSON.stringify(['BTC', 'ETH']),
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
      'Estrategia de ejemplo para probar el modulo de estrategias con cruce de medias moviles rapida/lenta.',
      JSON.stringify(['BTC', 'ETH']),
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

  logger.info('seed_ma_crossover_strategy_completed', {
    created: result.created,
    strategyId: result.strategy.id,
    userId: user.id,
    username: user.username,
    strategyName: STRATEGY_NAME,
  });

  await db.pool.end();
}

main().catch(async (err) => {
  logger.error('seed_ma_crossover_strategy_failed', { error: err.message, stack: err.stack });
  await db.pool.end().catch(() => {});
  process.exit(1);
});
