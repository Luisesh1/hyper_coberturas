const test = require('node:test');
const assert = require('node:assert/strict');

const { recommendRangeWidthPct } = require('../src/services/lp-orchestrator/range-recommender');

test('ancho base proporcional a la volatilidad (k·RV)', () => {
  const r = recommendRangeWidthPct({ rvPct: 60, currentWidthPct: 5, volMultiplier: 0.15 });
  // 60 * 0.15 = 9
  assert.equal(r.baseWidthPct, 9);
  assert.equal(r.recommendedWidthPct, 9);
  assert.equal(r.source, 'volatility');
});

test('time-in-range bajo (34%) ensancha el rango respecto al actual', () => {
  const r = recommendRangeWidthPct({
    rvPct: 60, timeInRangePct: 34, currentWidthPct: 5, volMultiplier: 0.15,
  });
  // max(9, 5) * 1.25 = 11.25 → debe superar tanto el actual (5) como el base (9)
  assert.equal(r.feedback, 'widen_low_time_in_range');
  assert.ok(r.recommendedWidthPct > 9, `esperado > 9, fue ${r.recommendedWidthPct}`);
  assert.equal(r.recommendedWidthPct, 11.25);
});

test('time-in-range alto (95%) angosta el rango para ganar más fees', () => {
  const r = recommendRangeWidthPct({
    rvPct: 40, timeInRangePct: 95, currentWidthPct: 8, volMultiplier: 0.15,
  });
  // min(6, 8) * 0.85 = 5.1
  assert.equal(r.feedback, 'narrow_high_time_in_range');
  assert.ok(r.recommendedWidthPct < 8, `esperado < 8, fue ${r.recommendedWidthPct}`);
  assert.equal(r.recommendedWidthPct, 5.1);
});

test('time-in-range medio no aplica feedback (mantiene base de vol)', () => {
  const r = recommendRangeWidthPct({
    rvPct: 50, timeInRangePct: 70, currentWidthPct: 5, volMultiplier: 0.15,
  });
  assert.equal(r.feedback, null);
  assert.equal(r.recommendedWidthPct, 7.5);
});

test('sin RV cae al ancho actual como base', () => {
  const r = recommendRangeWidthPct({ currentWidthPct: 6 });
  assert.equal(r.source, 'current_width');
  assert.equal(r.recommendedWidthPct, 6);
  assert.equal(r.rvPct, null);
});

test('respeta cotas min/max', () => {
  const hi = recommendRangeWidthPct({ rvPct: 1000, currentWidthPct: 5, maxWidthPct: 30 });
  assert.equal(hi.recommendedWidthPct, 30);
  const lo = recommendRangeWidthPct({ rvPct: 1, currentWidthPct: 5, minWidthPct: 1, volMultiplier: 0.15 });
  assert.equal(lo.recommendedWidthPct, 1); // 0.15 → clamp a 1
});

test('caso histórico: ETH ±5% con 34% TIR recomienda ensanchar de forma accionable', () => {
  // Sin RV disponible, solo el feedback empírico de time-in-range.
  const r = recommendRangeWidthPct({ timeInRangePct: 34, currentWidthPct: 5 });
  assert.equal(r.feedback, 'widen_low_time_in_range');
  assert.equal(r.recommendedWidthPct, 6.25); // 5 * 1.25
  assert.equal(r.source, 'tir');
});
