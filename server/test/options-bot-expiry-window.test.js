const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const alertsService = require('../src/services/alerts/alerts.service');
const templates = require('../src/services/options/templates');
const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');
const { createFakeShadowEntries } = require('./support/options-fake-shadow-entries');

const NOW = Date.UTC(2026, 9, 16, 9);
const SPOT = 60000;
const log = { info() {}, warn() {}, error() {} };

function baseAlert(overrides = {}) {
  return {
    name: 'BTC 15m RSI',
    assetList: ['BTCUSDT'],
    direction: 'bullish',
    rules: [{ weight: 1, conditions: [{ indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } }], joiners: [] }],
    ...overrides,
  };
}

test('bot de opciones: rango de vencimiento opcional, completo y válido', () => {
  const legacy = templates.validateParams('alert_signal', { alertIds: [11] });
  assert.equal(legacy.expiryMinDays, null);
  assert.equal(legacy.expiryMaxDays, null);
  const valid = templates.validateParams('alert_signal', { alertIds: [11], expiryMinDays: 2, expiryMaxDays: 4 });
  assert.deepEqual([valid.expiryMinDays, valid.expiryMaxDays], [2, 4]);
  assert.throws(() => templates.validateParams('alert_signal', { expiryMinDays: 2 }), /Vencimiento/);
  assert.throws(() => templates.validateParams('alert_signal', { expiryMinDays: 5, expiryMaxDays: 4 }), /Vencimiento/);
  assert.throws(() => templates.validateParams('alert_signal', { expiryMinDays: -1, expiryMaxDays: 4 }), /mínimo/);
  assert.throws(() => templates.validateParams('alert_signal', { expiryMinDays: 1, expiryMaxDays: 181 }), /máximo/);
});

test('alertas: el rango de vencimiento ya no forma parte de la alerta', () => {
  const data = alertsService.validatePayload(baseAlert({ optionExpiryMinDays: 2, optionExpiryMaxDays: 4 }));
  assert.equal('optionExpiryMinDays' in data, false);
  assert.equal('optionExpiryMaxDays' in data, false);
  const dto = alertsService.rowToDto({ direction: 'bullish', option_expiry_min_days: '2.000', option_expiry_max_days: '4.000' });
  assert.equal('optionExpiryMinDays' in dto, false);
});

test('migración 042: copia el rango de las alertas a los bots vinculados', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/042_bot_option_expiry_window.sql'), 'utf8');
  assert.match(sql, /expiryMinDays/);
  assert.match(sql, /expiryMaxDays/);
  assert.match(sql, /alert_signal/);
});

test('el rango del bot restringe vencimientos en modo sombra; el de la señal se ignora', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const expiries = syntheticExpiries(NOW);
  const market = {
    async getChain(underlying, code) {
      const expiry = expiries.find((x) => x.code === code) || expiries[0];
      return { ...buildSyntheticChain({ underlying, spot: SPOT, now: NOW, expiry, atmIv: 0.6, spreadPct: 4 }), expiries };
    },
    async getQuote(symbol) {
      const meta = parseSymbol(symbol);
      const expiry = expiries.find((e) => e.code === meta.expiry);
      if (!expiry) throw new Error('Vencimiento desconocido');
      const chain = buildSyntheticChain({ underlying: meta.underlying, spot: SPOT, now: NOW, expiry, atmIv: 0.6, spreadPct: 4 });
      const row = chain.rows.find((r) => Number(r.strike) === Number(meta.strike));
      if (!row) throw new Error('Strike desconocido');
      return { ...(meta.type === 'C' ? row.call : row.put), spot: SPOT };
    },
    async getPriceFilter() { return { tickSize: '0.01', minPrice: '0.01' }; },
  };
  const shadowEntries = createFakeShadowEntries({ now: () => NOW });
  const runner = new OptionsStrategyRunner({ repo, market, shadowEntries, logger: log, now: () => NOW });
  const service = createOptionsAutoTradingService({ repo, runner, logger: log, now: () => NOW, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({ userId: 7, name: 'Prueba en sombra', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [11], expiryMinDays: 2, expiryMaxDays: 4, entryPricing: 'mid' }, limits: {}, mode: 'shadow' });
  const narrow = await repo.createStrategy({ userId: 7, name: 'Fuera de rango', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [12], expiryMinDays: 90, expiryMaxDays: 91 }, limits: {}, mode: 'shadow' });
  const payload = { userId: 7, alertId: 11, alertName: 'BTC 15m', direction: 'bullish', asset: 'BTCUSDT', optionExpiryMinDays: 90, optionExpiryMaxDays: 91, eventId: 1 };
  const [accepted] = await service.handleAlertTriggered(payload);
  // La entrada en sombra espera al medio: el vencimiento es el de su contrato.
  assert.equal(accepted.decision, 'pending');
  const [position] = await shadowEntries.listPending({ strategyId: bot.id });
  assert.ok(position);
  const code = parseSymbol(position.symbol).expiry;
  const dte = expiries.find((e) => e.code === code).dte;
  assert.ok(dte >= 2 && dte <= 4, `vencimiento fuera de rango: ${dte} días`);
  const [rejected] = await service.handleAlertTriggered({ ...payload, alertId: 12, eventId: 2, optionExpiryMinDays: 2, optionExpiryMaxDays: 4 });
  assert.equal(rejected.decision, 'ignored');
  assert.equal((await shadowEntries.listPending({ strategyId: narrow.id })).length, 0);
});
