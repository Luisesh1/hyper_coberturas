const test = require('node:test');
const assert = require('node:assert/strict');

const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { createOptionsStrategiesService } = require('../src/services/options/options-strategies.service');
const { createAutoBotSchema, updateAutoBotSchema } = require('../src/schemas/options-automation.schema');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const NOW = Date.UTC(2026, 9, 16, 9);
const USER = 7;
const silent = { info() {}, warn() {}, error() {} };

function setup() {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const liveOrders = { async listByStrategy() { return []; } };
  const strategies = createOptionsStrategiesService({ repo, liveOrders, market: {}, credentials: {}, now: () => NOW });
  const alerts = [{ id: 11, name: 'Cruce', direction: 'bullish', assetList: ['BTCUSDT'] }];
  const service = createOptionsAutoTradingService({ repo, strategies, liveOrders, logger: silent, now: () => NOW,
    runner: { async runForSignal() { return { produced: [] }; } }, alerts: { listAlerts: async () => alerts } });
  return { repo, service };
}

const body = (limits) => ({ name: 'Bot', underlying: 'BTC', alertIds: [11], params: { structure: 'buy_with' }, ...(limits !== undefined ? { limits } : {}) });

test('crear un auto-bot guarda la pérdida diaria máx. enviada (y sin ella, el valor por defecto)', async () => {
  const { repo, service } = setup();
  const withLimit = await service.createBot(USER, body({ maxDailyLossUsdt: 250 }));
  assert.equal((await repo.getStrategy(USER, withLimit.id)).limits.maxDailyLossUsdt, 250);
  const plain = await service.createBot(USER, body());
  assert.equal((await repo.getStrategy(USER, plain.id)).limits.maxDailyLossUsdt, 100);
  const unlimited = await service.createBot(USER, body({ maxDailyLossUsdt: null }));
  assert.equal((await repo.getStrategy(USER, unlimited.id)).limits.maxDailyLossUsdt, null);
});

test('editar un auto-bot cambia la pérdida diaria máx. y conserva los demás límites', async () => {
  const { repo, service } = setup();
  const bot = await service.createBot(USER, body({ maxDailyLossUsdt: 100, maxOrdersPerDay: 3 }));
  await service.updateBot(USER, bot.id, { limits: { maxDailyLossUsdt: 400 } });
  const saved = (await repo.getStrategy(USER, bot.id)).limits;
  assert.equal(saved.maxDailyLossUsdt, 400);
  assert.equal(saved.maxOrdersPerDay, 3);
});

test('la pérdida diaria máx. de un auto-bot debe ser > 0 (o null = sin límite)', async () => {
  const { service } = setup();
  await assert.rejects(service.createBot(USER, body({ maxDailyLossUsdt: 0 })), /maxDailyLossUsdt/);
  const bot = await service.createBot(USER, body({ maxDailyLossUsdt: 50 }));
  await assert.rejects(service.updateBot(USER, bot.id, { limits: { maxDailyLossUsdt: 0 } }), /maxDailyLossUsdt/);
  // El schema de la ruta ya rechaza negativos.
  assert.equal(createAutoBotSchema.safeParse(body({ maxDailyLossUsdt: -1 })).success, false);
  assert.equal(updateAutoBotSchema.safeParse({ limits: { maxDailyLossUsdt: 120 } }).success, true);
});
