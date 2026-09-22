const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/repositories/lp-orchestrator.repository');

/**
 * Valor vivo de la cobertura en la caratula del orquestador.
 *
 * La carta decia QUE motor cubre pero no SI cubre algo: un hedge en cero y uno
 * a tamano completo se pintaban igual. Un LP descubierto es el fallo mas caro
 * del sistema y era el menos visible.
 *
 * El valor se deriva de `hedge_size * price_current`. La tentacion era leer
 * `hedge_notional_usd`, que ya existe — pero esa columna se queda rancia: al
 * cerrarse la cobertura de pp28 el 2026-09-22 quedo en 253.11 con `hedge_size`
 * ya en 0. Pintarla habria mostrado $253 de cobertura sobre un LP descubierto.
 */

function fakeExecutor(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

function baseRow(overrides = {}) {
  return {
    id: 55,
    user_id: 1,
    name: 'orq',
    network: 'arbitrum',
    version: 'v3',
    wallet_address: '0xabc',
    token0_address: '0x1',
    token1_address: '0x2',
    token0_symbol: 'ETH',
    token1_symbol: 'USDC',
    fee_tier: 3000,
    phase: 'lp_active',
    status: 'active',
    active_position_identifier: '209700',
    active_protected_pool_id: 28,
    initial_total_usd: 527,
    created_at: 1,
    updated_at: 2,
    // Campos del JOIN con la proteccion.
    active_protection_status: 'active',
    active_protection_policy_version: 'range_exit_v1',
    active_protection_center_dead_zone_pct: 0,
    active_protection_hedge_size: 0.0933,
    active_protection_price_current: 2736.55,
    active_protection_state_json: null,
    ...overrides,
  };
}

test('el valor de la cobertura sale de tamano x precio', async () => {
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow()));

  assert.equal(orch.activeHedge.hedgeQty, 0.0933);
  // 0.0933 * 2736.55 = 255.32
  assert.ok(Math.abs(orch.activeHedge.hedgeValueUsd - 255.32) < 0.01);
});

test('un hedge cerrado vale cero aunque la columna de notional siga rancia', async () => {
  // El caso real de pp28: hedge_size ya en 0, hedge_notional_usd todavia en
  // 253.11. La caratula tiene que decir cero, no $253.
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow({
    active_protection_hedge_size: 0,
    active_protection_price_current: 2733.35,
  })));

  assert.equal(orch.activeHedge.hedgeValueUsd, 0);
});

test('un short se reporta en valor positivo: es cuanto cubre, no su signo', async () => {
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow({
    active_protection_hedge_size: -0.0933,
  })));

  assert.ok(orch.activeHedge.hedgeValueUsd > 0);
});

test('sin precio no se inventa un valor', async () => {
  // Media cifra es peor que ninguna: `null` deja la caratula sin pintar nada,
  // que es la respuesta honesta.
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow({
    active_protection_price_current: null,
  })));

  assert.equal(orch.activeHedge.hedgeValueUsd, null);
});

test('el estado de estrategia cubre las protecciones sin columna poblada', async () => {
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow({
    active_protection_hedge_size: null,
    active_protection_price_current: null,
    active_protection_state_json: JSON.stringify({ hedgeSize: 0.05, priceCurrent: 2700 }),
  })));

  assert.ok(Math.abs(orch.activeHedge.hedgeValueUsd - 135) < 0.01);
});

test('sin proteccion vinculada no hay bloque de cobertura', async () => {
  const orch = await repo.getById(1, 55, fakeExecutor(baseRow({
    active_protected_pool_id: null,
    active_protection_status: null,
  })));

  assert.equal(orch.activeHedge, null);
  // Y eso es distinto de "cobertura en cero": aqui no hay a quien preguntarle.
  assert.equal(orch.activeProtectedPoolId, null);
});
