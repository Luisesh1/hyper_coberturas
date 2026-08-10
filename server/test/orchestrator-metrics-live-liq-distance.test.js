const test = require('node:test');
const assert = require('node:assert/strict');

const { OrchestratorMetricsService } = require('../src/services/orchestrator-metrics.service');
const calc = OrchestratorMetricsService.computeLiveDistanceToLiqPct;

// Contexto: `distance_to_liq_pct` solo se escribia en
// protected_pool_delta_rebalance_log, o sea SOLO al rebalancear. El dashboard y
// el reporte semanal hacian min() sobre esa tabla, asi que sin rebalanceos el
// numero se congelaba. Medido el 2026-08-10 con el ultimo rebalanceo 6h atras:
// se reportaba #35 al 8.4% (real 14.9%) y #37 al 13.7% (real 8.4%, pegado al
// umbral) — justo el que concentra el 78% del capital.

test('short: se liquida si el precio SUBE hasta liqPx', () => {
  // Caso real de #37 (2026-08-10): ETH 1875.05, liqPx 2035.2408706018.
  const pos = [{ asset: 'ETH', size: '-0.4622', liquidationPrice: '2035.2408706018' }];
  const d = calc(pos, 'ETH', 1875.05);
  assert.ok(Math.abs(d - 8.54) < 0.01, `esperado ~8.54%, fue ${d}`);
});

test('long: se liquida si el precio BAJA hasta liqPx', () => {
  const pos = [{ asset: 'ETH', size: '0.5', liquidationPrice: '1700' }];
  const d = calc(pos, 'ETH', 2000);
  assert.equal(d, 15); // (2000-1700)/2000
});

test('los tres orquestadores vivos reproducen la medicion on-chain', () => {
  const px = 1875.05;
  const casos = [
    ['#35', '-0.0451', '2156.2683144211', 15.00],
    ['#36', '-0.0594', '2198.929953126', 17.27],
    ['#37', '-0.4622', '2035.2408706018', 8.54],
  ];
  for (const [nombre, size, liq, esperado] of casos) {
    const d = calc([{ asset: 'ETH', size, liquidationPrice: liq }], 'ETH', px);
    assert.ok(Math.abs(d - esperado) < 0.02, `${nombre}: esperado ~${esperado}%, fue ${d}`);
  }
});

test('elige la posicion del activo del orquestador, no la primera', () => {
  const pos = [
    { asset: 'BTC', size: '-0.01', liquidationPrice: '99999' },
    { asset: 'ETH', size: '-0.5', liquidationPrice: '2200' },
  ];
  assert.equal(calc(pos, 'ETH', 2000), 10);
});

test('el match de activo es case-insensitive', () => {
  const pos = [{ asset: 'eth', size: '-0.5', liquidationPrice: '2200' }];
  assert.equal(calc(pos, 'ETH', 2000), 10);
});

// Devolver 0 en vez de null pintaria un 🔴 de liquidacion inminente sobre una
// posicion sana: cualquier dato ausente tiene que propagarse como "desconocido".
test('datos ausentes o invalidos dan null, nunca 0', () => {
  const ok = { asset: 'ETH', size: '-0.5', liquidationPrice: '2200' };
  assert.equal(calc(null, 'ETH', 2000), null, 'sin posiciones');
  assert.equal(calc([], 'ETH', 2000), null, 'lista vacia');
  assert.equal(calc([ok], null, 2000), null, 'sin activo');
  assert.equal(calc([ok], 'ETH', null), null, 'sin precio');
  assert.equal(calc([ok], 'ETH', 0), null, 'precio 0');
  assert.equal(calc([ok], 'BTC', 2000), null, 'activo que no esta');
  // Hyperliquid manda liquidationPx null en posiciones sin riesgo: no es error.
  assert.equal(calc([{ asset: 'ETH', size: '-0.5', liquidationPrice: null }], 'ETH', 2000), null);
  assert.equal(calc([{ asset: 'ETH', size: '0', liquidationPrice: '2200' }], 'ETH', 2000), null);
});
