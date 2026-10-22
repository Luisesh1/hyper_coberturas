const test = require('node:test');
const assert = require('node:assert/strict');

const alertsService = require('../src/services/alerts/alerts.service');

const { scoreAlert } = alertsService;

function rsiRule(weight, operator, value) {
  return {
    weight,
    conditions: [{
      indicatorType: 'rsi',
      indicatorParams: { length: 14 },
      timeframe: '15m',
      operandSeries: 'line',
      operator,
      operand: { kind: 'constant', value },
    }],
    joiners: [],
  };
}

// Serie creciente: RSI alto (>50), nunca < 30.
function risingCandles(n = 60) {
  const base = 1_700_000_000_000;
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i;
    return {
      time: base + i * 900_000,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    };
  });
}

test('scoreAlert puntúa reglas ponderadas', () => {
  const rules = [rsiRule(1, '>', 50), rsiRule(3, '<', 30)];
  const { ruleResults, score } = scoreAlert(rules, { '15m': risingCandles() });
  assert.equal(ruleResults.length, 2);
  assert.equal(ruleResults[0].matched, true);
  assert.equal(ruleResults[1].matched, false);
  assert.equal(score, 25);
});

test('scoreAlert convierte una excepción de regla en matched=false', () => {
  const rule = rsiRule(1, '>', 50);
  rule.conditions[0].indicatorType = 'nope';
  const { ruleResults, score } = scoreAlert([rule], { '15m': risingCandles() });
  assert.equal(ruleResults[0].matched, false);
  assert.match(ruleResults[0].reason, /^(indicador nope no soportado|error:)/);
  assert.equal(score, 0);
});
