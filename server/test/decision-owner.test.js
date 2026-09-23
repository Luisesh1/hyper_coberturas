const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/repositories/protection-decision-log.repository');
const { decideRangeExitV1, rangeKey } = require('../src/services/range-exit-policy.service');

/**
 * Que la politica pueda explicarse, y que se sepa quien goberno.
 *
 * `range_exit_v1` caia en la rama legacy al registrar el motivo, asi que sus
 * decisiones quedaban etiquetadas con `within_cost_aware_band` o
 * `drift_exceeds_cost_aware_band` — compuertas de un motor que no la gobierna.
 *
 * Medido en pp28 el 2026-09-23, sobre 37 ejecuciones:
 *
 *   risk_paused_reduce_only        20
 *   restart_reconcile               4
 *   timer_and_drift                 3   LEGACY
 *   naked_notional_cap_exceeded     3
 *   naked_notional_cap              3
 *   reanchor_manual                 2
 *   drift_exceeds_cost_aware_band   2   LEGACY
 *
 * CERO con una compuerta de `range_exit`. La politica decidia y otro se
 * atribuia el porque, asi que "¿que fraccion de las ordenes las decidio su
 * politica?" no tenia respuesta: era 0% y el registro no lo dejaba ver.
 */

const RANGO = { rangeLowerPrice: 2612, rangeUpperPrice: 2858 };
const KEY = rangeKey(2612, 2858);

// Compuertas que la politica puede devolver. Si alguna acaba en el log como
// string legacy, este test no lo ve — pero el de abajo si.
test('las compuertas de range_exit son nombres propios, no legacy', () => {
  const casos = [
    [{ deltaQty: 0.09, actualQty: 0, state: {} }, 'initial_full_hedge'],
    [{ deltaQty: 0.05, actualQty: 0.09, state: { rangeKey: KEY, zone: 'inside', committedTargetQty: 0.09 } }, 'inside_range_hold'],
    [{ deltaQty: 0.12, actualQty: 0.09, state: { rangeKey: KEY, zone: 'inside', committedTargetQty: 0.12 } }, 'commit_incomplete'],
  ];

  for (const [entrada, esperado] of casos) {
    const d = decideRangeExitV1({ ...RANGO, currentPrice: 2730, ...entrada });
    assert.equal(d.gate, esperado);
    assert.ok(
      !/cost_aware|timer_and_drift/.test(d.gate),
      `la politica no debe explicarse con vocabulario legacy: ${d.gate}`
    );
  }
});

// ---------------------------------------------------------------------------
// Persistencia del propietario.
// ---------------------------------------------------------------------------

function fakeExecutor() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1 }] }; } };
}

function valorDe(call, columna) {
  const cols = call.sql.slice(call.sql.indexOf('(') + 1, call.sql.indexOf(')'))
    .split(',').map((c) => c.trim());
  return call.params[cols.indexOf(columna)];
}

const BASE = { protectedPoolId: 28, decision: 'range_exit_rebalance', targetQty: 0.09, actualQty: 0.08 };

test('se guarda quien goberno el tick', async () => {
  const exec = fakeExecutor();
  await repo.create({ ...BASE, decisionOwner: 'policy', reason: 'range_exit' }, exec);

  assert.equal(valorDe(exec.calls[0], 'decision_owner'), 'policy');
  assert.equal(valorDe(exec.calls[0], 'reason'), 'range_exit');
});

test('una politica sobrescrita se distingue de una que manda', async () => {
  const exec = fakeExecutor();
  await repo.create({ ...BASE, decisionOwner: 'policy' }, exec);
  await repo.create({ ...BASE, decisionOwner: 'naked_cap' }, exec);
  await repo.create({ ...BASE, decisionOwner: 'risk_gate' }, exec);

  assert.deepEqual(
    exec.calls.map((c) => valorDe(c, 'decision_owner')),
    ['policy', 'naked_cap', 'risk_gate'],
    'sin esto, las tres filas se leen igual'
  );
});

test('sin propietario declarado se guarda nulo, no un valor inventado', async () => {
  const exec = fakeExecutor();
  await repo.create(BASE, exec);

  assert.equal(valorDe(exec.calls[0], 'decision_owner'), null);
});

test('la lectura devuelve el propietario', async () => {
  const exec = { query: async () => ({ rows: [{ id: 1, decisionOwner: 'naked_cap' }] }) };
  const [fila] = await repo.listByProtectedPoolId(28, {}, exec);

  assert.equal(fila.decisionOwner, 'naked_cap');
});

test('el propietario nulo se lee como null, no como cadena vacia', async () => {
  const exec = { query: async () => ({ rows: [{ id: 1, decisionOwner: null }] }) };
  const [fila] = await repo.listByProtectedPoolId(28, {}, exec);

  assert.equal(fila.decisionOwner, null);
});
