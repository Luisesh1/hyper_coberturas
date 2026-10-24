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

test('"Probar señal" (simulate) uses the same pending flow', async () => {
  const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
  const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
  const { parseSymbol } = require('../src/services/options/options-utils');
  const { createFakeShadowEntries } = require('./support/options-fake-shadow-entries');
  const clock = { now: NOW };
  const repo = createFakeOptionsRepo({ now: () => clock.now });
  const shadowEntries = createFakeShadowEntries({ now: () => clock.now });
  const expiries = syntheticExpiries(NOW);
  const chainOf = (code) => ({ ...buildSyntheticChain({ underlying: 'BTC', spot: 60000, now: NOW,
    expiry: expiries.find((x) => x.code === code) || expiries[0], atmIv: 0.6, spreadPct: 4 }), expiries });
  const book = { bid: 710, ask: 720 };
  const market = {
    async getChain(_u, expiry) { return chainOf(expiry); },
    async getQuote(symbol) {
      const meta = parseSymbol(symbol);
      const row = chainOf(meta.expiry).rows.find((r) => r.strike === meta.strike);
      return { ...(meta.type === 'C' ? row.call : row.put), ...meta, spot: 60000, ...book };
    },
    async getPriceFilter() { return { tickSize: '0.01', minPrice: '0.01' }; },
  };
  const runner = new OptionsStrategyRunner({ repo, market, shadowEntries, logger: silent, now: () => clock.now,
    credentials: { async getLimits() { return {}; } }, liveExecutor: { enabled: false, repo: {} } });
  const strategies = { async list() { return repo.listStrategies(USER); } };
  const service = createOptionsAutoTradingService({ repo, strategies, logger: silent, now: () => clock.now,
    runner, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({ userId: USER, name: 'B', template: 'alert_signal', underlying: 'BTC',
    params: { alertIds: [11] }, limits: {}, mode: 'shadow' });

  const outcome = await service.simulateSignal(USER, bot.id, { direction: 'bullish' });
  assert.deepEqual(outcome, { decision: 'pending', detail: 'Sombra: Orden LIMIT al medio, esperando ejecución' });
  const [signal] = repo.signals;
  assert.equal(signal.decision, 'pending');
  assert.equal(shadowEntries.entries[0].autoSignalId, signal.id);
  assert.equal(repo.positions.length, 0);

  book.ask = 715;
  clock.now = NOW + 60_000;
  assert.deepEqual(await runner.processShadowEntries(), { filled: 1, expired: 0 });
  assert.equal(repo.positions[0].entryPrice, 715);
  assert.equal(repo.signals[0].decision, 'opened');
  assert.equal(repo.signals[0].feesEstimated, true);
});
