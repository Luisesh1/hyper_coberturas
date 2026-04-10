const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRangePosition } = require('../src/services/lp-orchestrator/range-evaluator');

test('evaluateRangePosition: precio en el centro exacto está en banda central', () => {
  const result = evaluateRangePosition({
    priceCurrent: 100,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    edgeMarginPct: 40,
  });
  assert.equal(result.ok, true);
  assert.equal(result.inRange, true);
  assert.equal(result.inCentralBand, true);
  assert.equal(result.summary, 'central');
  // central band: 90 + 0.4*20 = 98 → 110 - 0.4*20 = 102
  assert.equal(result.centralBandLower, 98);
  assert.equal(result.centralBandUpper, 102);
});

test('evaluateRangePosition: precio justo fuera del 20% central pero dentro del rango → edge_warning', () => {
  const result = evaluateRangePosition({
    priceCurrent: 97,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    edgeMarginPct: 40,
  });
  assert.equal(result.inRange, true);
  assert.equal(result.inCentralBand, false);
  assert.equal(result.summary, 'edge_warning');
  assert.equal(result.nearEdgeSide, 'lower');
});

test('evaluateRangePosition: precio por debajo del rango → out_of_range below', () => {
  const result = evaluateRangePosition({
    priceCurrent: 85,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    edgeMarginPct: 40,
  });
  assert.equal(result.inRange, false);
  assert.equal(result.outOfRangeSide, 'below');
  assert.equal(result.summary, 'out_of_range');
});

test('evaluateRangePosition: precio por encima del rango → out_of_range above', () => {
  const result = evaluateRangePosition({
    priceCurrent: 120,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    edgeMarginPct: 40,
  });
  assert.equal(result.inRange, false);
  assert.equal(result.outOfRangeSide, 'above');
  assert.equal(result.summary, 'out_of_range');
});

test('evaluateRangePosition: edgeMarginPct=49 (banda central minúscula)', () => {
  const result = evaluateRangePosition({
    priceCurrent: 100,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    edgeMarginPct: 49,
  });
  assert.equal(result.inRange, true);
  // banda central: 90 + 0.49*20 = 99.8 → 110 - 0.49*20 = 100.2
  assert.equal(result.inCentralBand, true);
  assert.ok(result.centralBandLower > 99);
  assert.ok(result.centralBandUpper < 101);
});

test('evaluateRangePosition: rango inválido devuelve ok=false', () => {
  const result = evaluateRangePosition({
    priceCurrent: 100,
    rangeLowerPrice: 110,
    rangeUpperPrice: 90,
    edgeMarginPct: 40,
  });
  assert.equal(result.ok, false);
});
