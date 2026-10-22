const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChartAlertMarkers } = require('../src/services/settings.service');

test('normalizeChartAlertMarkers: default vacío para entrada inválida', () => {
  assert.deepEqual(normalizeChartAlertMarkers(null), { items: [] });
  assert.deepEqual(normalizeChartAlertMarkers({ items: 'x' }), { items: [] });
});

test('normalizeChartAlertMarkers: descarta alertId no numérico y deduplica', () => {
  const out = normalizeChartAlertMarkers({
    items: [
      { alertId: 1, color: '#fff', hidden: false },
      { alertId: 'abc', color: '#000', hidden: false },
      { alertId: 1, color: '#111', hidden: true },
      { alertId: 2, color: 5, hidden: 1 },
      null,
    ],
  });
  assert.deepEqual(out.items.map((i) => i.alertId), [1, 2]);
  assert.equal(out.items[0].color, '#fff');
  assert.equal(out.items[1].hidden, false);
});

test('normalizeChartAlertMarkers: corta a 6', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ alertId: i + 1, color: '#abc', hidden: false }));
  assert.equal(normalizeChartAlertMarkers({ items }).items.length, 6);
});
