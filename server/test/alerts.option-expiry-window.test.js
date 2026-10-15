const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const alertsService = require('../src/services/alerts/alerts.service');
const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

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

test('alertas: rango de opciones es opcional pero debe ser completo y válido', () => {
  const legacy = alertsService.validatePayload(baseAlert());
  assert.equal(legacy.optionExpiryMinDays, null);
  assert.equal(legacy.optionExpiryMaxDays, null);
  const valid = alertsService.validatePayload(baseAlert({ optionExpiryMinDays: 2, optionExpiryMaxDays: 4 }));
  assert.deepEqual([valid.optionExpiryMinDays, valid.optionExpiryMaxDays], [2, 4]);
  assert.throws(() => alertsService.validatePayload(baseAlert({ optionExpiryMinDays: 2 })), /Vencimiento/);
  assert.throws(() => alertsService.validatePayload(baseAlert({ optionExpiryMinDays: 5, optionExpiryMaxDays: 4 })), /Vencimiento/);
  assert.throws(() => alertsService.validatePayload(baseAlert({ optionExpiryMinDays: -1, optionExpiryMaxDays: 4 })), /optionExpiryMinDays/);
});

test('alertas: lectura de fila persistida conserva el rango', () => {
  const dto = alertsService.rowToDto({ direction: 'bullish', option_expiry_min_days: '2.000', option_expiry_max_days: '4.000' });
  assert.deepEqual([dto.optionExpiryMinDays, dto.optionExpiryMaxDays], [2, 4]);
  const old = alertsService.rowToDto({});
  assert.equal(old.optionExpiryMinDays, null);
  assert.equal(old.optionExpiryMaxDays, null);
});

test('migración de rango: deja alertas anteriores sin filtro y exige ambos límites', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/034_alert_option_expiry_window.sql'), 'utf8');
  assert.match(sql, /option_expiry_min_days/);
  assert.match(sql, /option_expiry_max_days/);
  assert.match(sql, /option_expiry_max_days >= option_expiry_min_days/);
});

test('alerta disparada restringe vencimientos del bot en modo sombra, sin órdenes reales', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const expiries = syntheticExpiries(NOW);
  const market = {
    async getChain(underlying, code) {
      const expiry = expiries.find((x) => x.code === code) || expiries[0];
      return { ...buildSyntheticChain({ underlying, spot: SPOT, now: NOW, expiry, atmIv: 0.6, spreadPct: 4 }), expiries };
    },
    async getQuote() { throw new Error('No hay posiciones abiertas'); },
  };
  const runner = new OptionsStrategyRunner({ repo, market, logger: log, now: () => NOW });
  const service = createOptionsAutoTradingService({ repo, runner, logger: log, now: () => NOW, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({ userId: 7, name: 'Prueba en sombra', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [11] }, limits: {}, mode: 'shadow' });
  const payload = { userId: 7, alertId: 11, alertName: 'BTC 15m', direction: 'bullish', asset: 'BTCUSDT', optionExpiryMinDays: 2, optionExpiryMaxDays: 4, eventId: 1 };
  const [accepted] = await service.handleAlertTriggered(payload);
  assert.equal(accepted.decision, 'opened');
  const [position] = await repo.listOpenPositions(bot.id, 'shadow');
  assert.ok(position);
  const code = parseSymbol(position.symbol).expiry;
  const dte = expiries.find((e) => e.code === code).dte;
  assert.ok(dte >= 2 && dte <= 4, `vencimiento fuera de rango: ${dte} días`);
  const [rejected] = await service.handleAlertTriggered({ ...payload, eventId: 2, optionExpiryMinDays: 90, optionExpiryMaxDays: 91 });
  assert.equal(rejected.decision, 'ignored');
  assert.equal((await repo.listOpenPositions(bot.id, 'shadow')).length, 1);
});
