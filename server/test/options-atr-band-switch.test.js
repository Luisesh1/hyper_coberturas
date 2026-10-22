const test = require('node:test');
const assert = require('node:assert/strict');

const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { createOptionsStrategiesService } = require('../src/services/options/options-strategies.service');
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
  const create = (params = {}) => repo.createStrategy({ userId: USER, name: 'Bot', template: 'alert_signal', underlying: 'BTC',
    params: { alertIds: [11], structure: 'buy_with', takeProfitMode: 'fixed', ...params }, limits: {}, mode: 'live' });
  const position = (bot, mode) => repo.insertPosition({ strategyId: bot.id, userId: USER, mode, symbol: 'BTC-261030-70000-C',
    side: 'BUY', quantity: 0.01, entryPrice: 10, openedAt: NOW, feesUsdt: 0 });
  return { repo, service, strategies, create, position };
}

const toAtr = { params: { structure: 'buy_with', takeProfitMode: 'atr_band', alertIds: [11] } };
const is409 = (err) => err.status === 409 && err.code === 'OPEN_LIVE_POSITIONS' &&
  err.message === 'Cierra las posiciones reales abiertas antes de cambiar a venta por banda ATR';

test('cambiar a banda ATR con posiciones reales abiertas: 409 OPEN_LIVE_POSITIONS y no se guarda', async () => {
  const { repo, service, strategies, create, position } = setup();
  const bot = await create();
  await position(bot, 'live');
  await assert.rejects(service.updateBot(USER, bot.id, toAtr), is409);
  // También por la ruta genérica de estrategias.
  await assert.rejects(strategies.update(USER, bot.id, { params: { takeProfitMode: 'atr_band' } }), is409);
  assert.equal((await repo.getStrategy(USER, bot.id)).params.takeProfitMode, 'fixed');
  // Otros cambios de params siguen permitidos.
  const ok = await service.updateBot(USER, bot.id, { params: { takeProfitPct: 90 } });
  assert.equal(ok.params.takeProfitPct, 90);
});

test('banda ATR: posiciones solo en sombra no bloquean; ya en atr_band tampoco', async () => {
  const { service, create, position } = setup();
  const shadow = await create();
  await position(shadow, 'shadow');
  assert.equal((await service.updateBot(USER, shadow.id, toAtr)).params.takeProfitMode, 'atr_band');

  const already = await create({ takeProfitMode: 'atr_band' });
  await position(already, 'live');
  assert.equal((await service.updateBot(USER, already.id, { params: { ...toAtr.params, atrBandMultiplier: 3 } })).params.atrBandMultiplier, 3);
});
