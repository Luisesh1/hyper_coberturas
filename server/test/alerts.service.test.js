const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAlertMessage, validatePayload } = require('../src/services/alerts/alerts.service');

test('buildAlertMessage muestra labels de reglas aprobadas', () => {
  const text = buildAlertMessage({
    alert: { name: 'BTC Alert', thresholdPercent: 70 },
    asset: 'BTCUSDT',
    score: 100,
    matched: [
      { rule: { label: 'RSI sobreventa' }, reason: 'RSI(14).line < 30 (25 < 30)' },
      { rule: { label: 'MACD <bull>' }, reason: 'MACD cruza al alza' },
    ],
    total: 3,
    candleCloseTime: Date.UTC(2026, 0, 1, 12, 0, 0),
    lowestTf: '15m',
    sentAt: Date.UTC(2026, 0, 1, 12, 5, 30),
  });

  assert.match(text, /Labels de reglas aprobadas \(2\/2, 3 total\):/);
  assert.match(text, /RSI sobreventa/);
  assert.match(text, /MACD &lt;bull&gt;/);
  assert.doesNotMatch(text, /RSI\(14\)\.line < 30/);
  assert.match(text, /Enviada UTC: <b>2026-01-01 12:05:30 UTC<\/b>/);
});

test('validatePayload conserva label por regla', () => {
  const payload = validatePayload({
    name: 'BTC Alert',
    isActive: true,
    thresholdPercent: 100,
    cooldownSeconds: 900,
    telegramEnabled: true,
    datasource: 'binance',
    assetList: ['BTCUSDT'],
    rules: [{
      label: 'RSI sobreventa',
      weight: 1,
      conditions: [{
        indicatorType: 'rsi',
        indicatorParams: { length: 14 },
        timeframe: '15m',
        operandSeries: 'line',
        operator: '<',
        operand: { kind: 'constant', value: 30 },
      }],
      joiners: [],
    }],
  });

  assert.equal(payload.rules[0].label, 'RSI sobreventa');
});
