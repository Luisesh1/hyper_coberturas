const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAlertMessage,
  calculateWeightedScore,
  filterClosedCandles,
  lowestTimeframe,
  validatePayload,
} = require('../src/services/alerts/alerts.service');

test('lowestTimeframe incluye la temporalidad de una serie usada como operando', () => {
  const rules = [{
    weight: 1,
    conditions: [{
      indicatorType: 'rsi',
      timeframe: '1h',
      operator: '>',
      operand: {
        kind: 'series',
        indicatorType: 'ema',
        timeframe: '1m',
      },
    }],
  }];

  assert.equal(lowestTimeframe(rules), '1m');
});

test('calculateWeightedScore no convierte peso cero en uno', () => {
  const rules = [{ weight: 0 }, { weight: 2 }];
  const results = [
    { rule: rules[0], matched: true },
    { rule: rules[1], matched: false },
  ];

  assert.deepEqual(calculateWeightedScore(rules, results), {
    totalWeight: 2,
    matchedWeight: 0,
    score: 0,
  });
});

test('filterClosedCandles excluye la vela que todavía está en formación', () => {
  const base = 1_780_000_000_000;
  const candles = [
    { time: base, closeTime: base + 59_999, close: 10 },
    { time: base + 60_000, closeTime: base + 119_999, close: 20 },
  ];

  assert.deepEqual(filterClosedCandles(candles, '1m', base + 63_000), [candles[0]]);
});

test('filterClosedCandles calcula el cierre desde time cuando el provider no da closeTime', () => {
  const base = 1_780_000_000_000;
  const candles = [
    { time: base, close: 10 },
    { time: base + 60_000, close: 20 },
  ];

  assert.deepEqual(filterClosedCandles(candles, '1m', base + 63_000), [candles[0]]);
});

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
