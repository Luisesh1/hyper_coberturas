const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pruneDecisionLog,
} = require('../src/services/protected-pool-maintenance.service');

/**
 * Cadencia del lazo fuera de rango, y retencion del log (Fase 5).
 *
 * `nearBoundary` incluye `zoneState === 'outside'`, y fuera del rango eso es
 * permanentemente cierto: el camino urgente —pensado para un cruce
 * transitorio— se volvia permanente y el lazo pasaba de 30 s a 2 s sin volver.
 *
 *   dentro de rango   120 filas/hora/pool
 *   fuera de rango  1.760 filas/hora/pool   (desde el 2026-09-18, continuo)
 *
 * `protection_decision_log` acabo en 6,49 M de filas / 1,79 GB contra 592
 * rebalanceos reales: ~11.000 filas por rebalanceo, sin retencion.
 *
 * El diseno estaba invertido: cuando el precio se estaciona fuera, el LP no
 * cobra fees y deberia trabajar MENOS, no 15 veces mas.
 */

// Reproduce el gate de `_tickProtection` sobre un reloj controlado, sin montar
// el servicio entero: lo que se prueba es la decision de evaluar o no.
function buildGate({ fullEvalMs = 30_000, urgencyMs = 15 * 60_000 } = {}) {
  const lastEvalAt = new Map();
  const nearBoundarySince = new Map();
  const id = 27;

  return function tick({ now, zoneState, crossedBoundary = false }) {
    const nearBoundary = zoneState === 'edge' || zoneState === 'outside';
    const evalDue = (now - (lastEvalAt.get(id) || 0)) >= fullEvalMs;

    if (!nearBoundary) {
      nearBoundarySince.delete(id);
    } else if (!nearBoundarySince.has(id)) {
      nearBoundarySince.set(id, now);
    }
    const nearBoundaryFresh = nearBoundary
      && (now - (nearBoundarySince.get(id) || now)) <= urgencyMs;

    if (!evalDue && !crossedBoundary && !nearBoundaryFresh) return false;
    lastEvalAt.set(id, now);
    return true;
  };
}

test('al entrar en zona de borde el lazo evalua en cada tick', () => {
  const tick = buildGate();
  const t0 = 1_800_000_000_000;

  assert.equal(tick({ now: t0, zoneState: 'outside' }), true);
  // 2 s despues: el throttle de 30 s no ha vencido y aun asi evalua, que es
  // justo lo que hace util al camino urgente.
  assert.equal(tick({ now: t0 + 2_000, zoneState: 'outside' }), true);
  assert.equal(tick({ now: t0 + 4_000, zoneState: 'outside' }), true);
});

test('si el precio se estaciona fuera, la urgencia caduca y vuelve la cadencia larga', () => {
  const tick = buildGate();
  const t0 = 1_800_000_000_000;

  tick({ now: t0, zoneState: 'outside' });

  // Pasados los 15 min de urgencia, un tick a los 2 s ya no evalua.
  const t1 = t0 + (16 * 60_000);
  assert.equal(tick({ now: t1, zoneState: 'outside' }), true, 'este entra por el throttle vencido');
  assert.equal(
    tick({ now: t1 + 2_000, zoneState: 'outside' }),
    false,
    'aqui estaba el bug: 2 s despues volvia a evaluar, para siempre'
  );
  // Y a los 30 s vuelve a entrar: 120 filas/hora, no 1.760.
  assert.equal(tick({ now: t1 + 30_000, zoneState: 'outside' }), true);
});

test('un cruce de borde sigue disparando evaluacion inmediata, siempre', () => {
  const tick = buildGate();
  const t0 = 1_800_000_000_000;

  tick({ now: t0, zoneState: 'outside' });
  // Mucho despues de que caduque la urgencia, y sin que venza el throttle.
  const tarde = t0 + (10 * 60 * 60_000);
  tick({ now: tarde, zoneState: 'outside' });
  assert.equal(
    tick({ now: tarde + 1_000, zoneState: 'outside', crossedBoundary: true }),
    true,
    'el cruce es un evento real: no se posterga'
  );
});

test('volver dentro del rango rearma la urgencia para la proxima salida', () => {
  const tick = buildGate();
  const t0 = 1_800_000_000_000;

  tick({ now: t0, zoneState: 'outside' });
  // Vuelve al centro: se olvida el reloj de borde.
  tick({ now: t0 + (20 * 60_000), zoneState: 'center' });
  // Sale otra vez: urgencia nueva, no la caducada de la salida anterior.
  const t2 = t0 + (21 * 60_000);
  assert.equal(tick({ now: t2, zoneState: 'outside' }), true);
  assert.equal(tick({ now: t2 + 2_000, zoneState: 'outside' }), true);
});

// ---------------------------------------------------------------------------
// Retencion del log.
// ---------------------------------------------------------------------------

function fakeExecutor({ count = 0, deletePerCall = [] } = {}) {
  const calls = [];
  let deleteIdx = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/count\(\*\)/.test(sql)) return { rows: [{ total: String(count) }] };
      const rowCount = deletePerCall[deleteIdx] ?? 0;
      deleteIdx += 1;
      return { rows: [], rowCount };
    },
  };
}

test('la poda es dry-run por defecto: cuenta y no borra', async () => {
  const exec = fakeExecutor({ count: 6_492_134 });

  const resumen = await pruneDecisionLog({ retentionDays: 30 }, exec);

  assert.equal(resumen.dryRun, true);
  assert.equal(resumen.candidates, 6_492_134);
  assert.equal(resumen.deleted, 0);
  assert.equal(exec.calls.length, 1, 'un SELECT y ninguna escritura');
  assert.doesNotMatch(exec.calls[0].sql, /DELETE/i);
});

test('con --apply borra por lotes, no en una sola transaccion', async () => {
  // 120.000 filas con lotes de 50.000: dos lotes llenos y uno parcial.
  const exec = fakeExecutor({ count: 120_000, deletePerCall: [50_000, 50_000, 20_000] });

  const resumen = await pruneDecisionLog({ retentionDays: 30, dryRun: false }, exec);

  assert.equal(resumen.deleted, 120_000);
  const deletes = exec.calls.filter((c) => /DELETE/i.test(c.sql));
  assert.equal(deletes.length, 3, 'un DELETE unico sobre millones de filas bloquearia al motor');
});

test('la ventana de retencion se traduce a un corte temporal coherente', async () => {
  const exec = fakeExecutor({ count: 0 });
  const antes = Date.now();

  const resumen = await pruneDecisionLog({ retentionDays: 7 }, exec);

  assert.equal(resumen.retentionDays, 7);
  assert.ok(resumen.cutoffMs <= antes - (7 * 86_400_000));
  assert.ok(resumen.cutoffMs > antes - (8 * 86_400_000));
});
