const test = require('node:test');
const assert = require('node:assert/strict');

const { createOptionsStrategiesRepository } = require('../src/repositories/options-strategies.repository');
const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const USER = 7;
const NOW = Date.UTC(2026, 9, 16, 9);
const silent = { info() {}, warn() {}, error() {} };

function capturingDb() {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); return { rows: [] }; } };
}

test('repositorio: última señal y filtro «Operadas» excluyen simuladas; «Todas» las incluye', async () => {
  const db = capturingDb();
  const repo = createOptionsStrategiesRepository({ db });
  await repo.lastAutoSignalsByUser(USER);
  assert.match(db.calls[0].sql, /NOT simulated/);
  await repo.listAutoSignals(4, { filter: 'traded' });
  assert.match(db.calls[1].sql, /NOT \(\$4::boolean AND simulated\)/);
  assert.equal(db.calls[1].args[3], true);
  await repo.listAutoSignals(4, { filter: 'all' });
  assert.equal(db.calls[2].args[3], false);
  await repo.listAutoSignals(4, { filter: 'ignored' });
  assert.equal(db.calls[3].args[3], false);
});

test('servicio: lastSignal y «Operadas» ignoran señales simuladas; «Todas» las muestra', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const strategies = { async list() { return repo.listStrategies(USER); } };
  const service = createOptionsAutoTradingService({ repo, strategies, logger: silent, now: () => NOW,
    runner: { async runForSignal() { return { produced: [] }; } }, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({ userId: USER, name: 'B', template: 'alert_signal', underlying: 'BTC',
    params: { alertIds: [11] }, limits: {}, mode: 'shadow' });
  await repo.claimAutoSignal({ strategyId: bot.id, userId: USER, alertId: 11, alertEventId: 1, alertName: 'Real',
    direction: 'bullish', asset: 'BTC', decision: 'opened', createdAt: NOW });
  await repo.claimAutoSignal({ strategyId: bot.id, userId: USER, alertId: null, alertEventId: null, alertName: 'Simulación',
    direction: 'bearish', asset: 'BTC', decision: 'closed', simulated: true, createdAt: NOW + 1000 });
  const [listed] = await service.listBots(USER);
  assert.equal(listed.lastSignal.alertName, 'Real');
  const traded = await service.listSignals(USER, bot.id, { filter: 'traded' });
  assert.deepEqual(traded.map((s) => s.alertName), ['Real']);
  const all = await service.listSignals(USER, bot.id, { filter: 'all' });
  assert.deepEqual(all.map((s) => [s.alertName, s.simulated]), [['Simulación', true], ['Real', false]]);
});
