const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveNakedExposure,
  normalizeEvaluationStatus,
} = require('../src/services/protected-pool-delta-neutral.helpers');

/**
 * Exposicion direccional sostenida (pp27 / orq #54, 2026-09-18 → 09-21).
 *
 * El precio salio por arriba del rango, el delta del LP colapso a ~0 y la
 * politica latcheo el hedge en 0.0226 ETH. Quedaron $53.90 de short desnudo
 * durante ~72 h. El sistema lo detectaba —`delta_neutral_coverage_out_of_band`
 * disparo 5.265 veces en 3 horas— y no lo comunicaba: era un `warn` suelto.
 * Ademas se reportaba `strategy_status: tracking`, `fallos: 0`, `ult_error`
 * vacio: en el panel la proteccion se veia sana.
 *
 * Dos decisiones de diseno que estos tests fijan:
 *
 * 1. Se mide el NOTIONAL EN USD, no el ratio actual/target. Con el delta
 *    tendiendo a 0 el ratio se dispara a 40x-290x sin que pase nada anomalo
 *    —es el comportamiento normal de `range_exit_v1` cerca del borde— asi que
 *    un umbral por ratio la marcaria rota permanentemente.
 * 2. Se avisa al CRUZAR un escalon de duracion, no por tick.
 */

// Cifras reales del tick de las 19:53:50Z del 2026-09-21.
const PP27 = { nakedNotionalUsd: 53.90, poolValueUsd: 353.29 };
const T0 = 1_800_000_000_000;
const MIN = 60_000;

test('un descuadre trivial en USD no es exposicion, aunque el ratio se vea feo', () => {
  // pp24 el mismo dia: target 0.002782 vs actual 0.0028 -> $0.05 sobre $319.
  const r = resolveNakedExposure({ nakedNotionalUsd: 0.05, poolValueUsd: 319.56, now: T0 });
  assert.equal(r.material, false);
  assert.equal(r.tier, -1);
  assert.equal(r.escalated, false);
});

test('range_exit_v1 cerca del borde no dispara pese a un ratio de 30x', () => {
  // Delta casi agotado (0.0001) contra un hedge de apertura de 0.003: el ratio
  // es 30x, pero lo realmente descubierto son $7.25 sobre un pool de $320.
  // Un umbral por ratio la marcaria rota; el umbral en USD la deja en paz.
  const r = resolveNakedExposure({ nakedNotionalUsd: 7.25, poolValueUsd: 320, now: T0 });
  assert.equal(r.material, false, 'la politica de borde de rango no puede vivir en alerta');
});

test('un monto grande sobre un pool mucho mayor tampoco alarma', () => {
  // $20 desnudos en un pool de $2.000 son el 1%: por encima del piso absoluto,
  // por debajo del relativo. Hacen falta LAS DOS condiciones.
  const r = resolveNakedExposure({ nakedNotionalUsd: 20, poolValueUsd: 2_000, now: T0 });
  assert.equal(r.material, false);
});

test('pp27 es material desde el primer tick, pero todavia no se avisa', () => {
  const r = resolveNakedExposure({ ...PP27, now: T0 });
  assert.equal(r.material, true);
  assert.equal(r.since, T0, 'el episodio arranca su reloj aqui');
  assert.equal(r.tier, -1, 'sin duracion suficiente no hay severidad');
  assert.equal(r.escalated, false, 'avisar al instante convertiria un blip en ruido');
});

test('a los 15 minutos cruza el primer escalon y avisa una sola vez', () => {
  const primero = resolveNakedExposure({
    ...PP27, now: T0 + (16 * MIN), priorSince: T0, priorTier: -1,
  });
  assert.equal(primero.tier, 0);
  assert.equal(primero.severity, 'warning');
  assert.equal(primero.escalated, true);

  // Mismo escalon en el tick siguiente: NO vuelve a avisar. Esto es lo que
  // convierte 5.265 warns en 3 alertas.
  const siguiente = resolveNakedExposure({
    ...PP27, now: T0 + (16 * MIN) + 2_000, priorSince: T0, priorTier: 0,
  });
  assert.equal(siguiente.tier, 0);
  assert.equal(siguiente.escalated, false);
});

test('la severidad escala con la duracion del episodio', () => {
  const unaHora = resolveNakedExposure({ ...PP27, now: T0 + (61 * MIN), priorSince: T0, priorTier: 0 });
  assert.equal(unaHora.severity, 'high');
  assert.equal(unaHora.escalated, true);

  const seisHoras = resolveNakedExposure({ ...PP27, now: T0 + (7 * 60 * MIN), priorSince: T0, priorTier: 1 });
  assert.equal(seisHoras.severity, 'critical');
  assert.equal(seisHoras.escalated, true);

  // pp27 estuvo 72 h: sigue en critical, sin volver a escalar.
  const tresDias = resolveNakedExposure({ ...PP27, now: T0 + (72 * 60 * MIN), priorSince: T0, priorTier: 2 });
  assert.equal(tresDias.severity, 'critical');
  assert.equal(tresDias.escalated, false);
});

test('al cerrarse el episodio el reloj se reinicia', () => {
  const cerrado = resolveNakedExposure({
    nakedNotionalUsd: 0.4, poolValueUsd: 353.29, now: T0 + (80 * 60 * MIN), priorSince: T0, priorTier: 2,
  });
  assert.equal(cerrado.material, false);
  assert.equal(cerrado.since, null, 'un episodio nuevo no puede heredar el reloj del anterior');
  assert.equal(cerrado.tier, -1);
});

// ---------------------------------------------------------------------------
// El estado reportado tiene que reflejar la exposicion.
// ---------------------------------------------------------------------------

test('un hold que sostiene exposicion sostenida deja de llamarse tracking', () => {
  const base = {
    decision: 'hold',
    trackingErrorUsd: 53.90,
    riskStatus: null,
    preflightStatus: null,
    shouldRebalance: false,
    preflightOk: true,
  };

  assert.equal(
    normalizeEvaluationStatus({ ...base, nakedExposureSustained: true }),
    'naked_exposure',
    'pp27 paso 3 dias reportandose sano con $53.90 de short desnudo'
  );
  assert.equal(
    normalizeEvaluationStatus({ ...base, nakedExposureSustained: false }),
    'tracking',
    'un descuadre pasajero sigue siendo seguimiento normal'
  );
});

test('una correccion ya en curso pesa mas que la exposicion', () => {
  // Si el motor ya decidio rebalancear y el preflight paso, lo informativo es
  // que hay una orden en camino, no que todavia falta cubrir.
  assert.equal(
    normalizeEvaluationStatus({
      decision: 'rebalance_full',
      trackingErrorUsd: 53.90,
      riskStatus: null,
      preflightStatus: null,
      shouldRebalance: true,
      preflightOk: true,
      nakedExposureSustained: true,
    }),
    'rebalance_pending'
  );
});

test('un gate de riesgo sigue mandando sobre todo lo demas', () => {
  assert.equal(
    normalizeEvaluationStatus({
      decision: 'hold',
      trackingErrorUsd: 53.90,
      riskStatus: 'risk_paused',
      preflightStatus: null,
      shouldRebalance: false,
      preflightOk: false,
      nakedExposureSustained: true,
    }),
    'risk_paused'
  );
});

// ---------------------------------------------------------------------------
// Registro durable: el canal que NO depende de que Telegram entregue.
// ---------------------------------------------------------------------------

const hedgeAlerts = require('../src/repositories/hedge-alerts.repository');

function fakeExecutor(rows = [], rowCount = 0) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows, rowCount };
    },
  };
}

test('summarizeOpen cuenta EPISODIOS y se queda con la peor severidad', async () => {
  const exec = fakeExecutor([
    { severity: 'warning', episodes: '2' },
    { severity: 'critical', episodes: '1' },
  ]);

  const resumen = await hedgeAlerts.summarizeOpen(exec);

  assert.equal(resumen.openEpisodes, 3);
  assert.equal(resumen.worstSeverity, 'critical');
  assert.deepEqual(resumen.bySeverity, { warning: 2, high: 0, critical: 1 });
  // Un episodio que escalo warning -> high -> critical son 3 filas y UN
  // problema. Si esto contara filas, el health check exageraria.
  assert.match(exec.calls[0].sql, /count\(DISTINCT/i);
});

test('sin episodios abiertos no hay severidad', async () => {
  const resumen = await hedgeAlerts.summarizeOpen(fakeExecutor([]));
  assert.equal(resumen.openEpisodes, 0);
  assert.equal(resumen.worstSeverity, null);
});

test('un escalon se guarda con el inicio del episodio, no con el suyo', async () => {
  const exec = fakeExecutor([{ id: 7 }]);

  await hedgeAlerts.create({
    protectedPoolId: 27,
    alertType: 'naked_exposure',
    severity: 'critical',
    episodeStartedAt: T0,
    message: 'Exposicion direccional sin cubrir: $53.90 desde hace 4320 min',
    details: { nakedNotionalUsd: 53.9 },
  }, exec);

  const { params } = exec.calls[0];
  assert.equal(params[0], 27);
  assert.equal(params[1], 'naked_exposure');
  assert.equal(params[2], 'critical');
  assert.equal(params[3], T0, 'es lo que permite agrupar los escalones del mismo episodio');
  assert.equal(JSON.parse(params[5]).nakedNotionalUsd, 53.9);
});

test('resolver un episodio abierto es idempotente por construccion', async () => {
  const exec = fakeExecutor([], 0);
  const cerradas = await hedgeAlerts.resolveOpenByType({
    protectedPoolId: 27, alertType: 'naked_exposure',
  }, exec);

  assert.equal(cerradas, 0, 'volver a cerrar lo ya cerrado no es un error');
  assert.match(exec.calls[0].sql, /resolved_at IS NULL/, 'solo toca lo que sigue abierto');
});

// ---------------------------------------------------------------------------
// Tope de exposicion direccional (Fase 3): limite de RIESGO, por encima de la
// politica. Exige magnitud Y duracion — ver el comentario del helper.
// ---------------------------------------------------------------------------

const { resolveNakedNotionalBreach } = require('../src/services/protected-pool-delta-neutral.helpers');
const { decideNetProfitV1 } = require('../src/services/net-profit-policy.service');

test('pp27 supera el tope una vez que la exposicion se sostiene', () => {
  // 15.3% del pool, sostenido mas de una hora (tier 1).
  const r = resolveNakedNotionalBreach({ ...PP27, tier: 1 });
  assert.equal(r.breached, true);
  assert.ok(r.capUsd < PP27.nakedNotionalUsd);
});

test('la misma exposicion recien aparecida NO dispara el tope', () => {
  // tier 0 = lleva 15 min. Se avisa, no se interviene: una divergencia puede
  // cerrarse sola en el cruce de borde siguiente.
  const r = resolveNakedNotionalBreach({ ...PP27, tier: 0 });
  assert.equal(r.sustained, false);
  assert.equal(r.breached, false);
});

test('la divergencia deliberada de range_exit_v1 no se recorta', () => {
  // Esta es LA regresion a evitar. `range_exit_v1` paga divergencia a proposito
  // para no pagar comisiones; un tope que la recorte destruye la politica.
  // $7.25 sobre un pool de $320 es 2.3%: por debajo del tope aunque lleve dias.
  const r = resolveNakedNotionalBreach({ nakedNotionalUsd: 7.25, poolValueUsd: 320, tier: 2 });
  assert.equal(r.breached, false, 'una divergencia chica y larga sigue siendo su modo normal de operar');
});

test('el tope escala con el pool, con un piso para los pools chicos', () => {
  const grande = resolveNakedNotionalBreach({ nakedNotionalUsd: 0, poolValueUsd: 10_000, tier: 2 });
  assert.equal(grande.capUsd, 1_500, '15% de $10.000');

  // En un pool minusculo el 15% seria calderilla; manda el piso absoluto.
  const chico = resolveNakedNotionalBreach({ nakedNotionalUsd: 0, poolValueUsd: 50, tier: 2 });
  assert.equal(chico.capUsd, 30);
});

test('el tope es configurable por proteccion', () => {
  const r = resolveNakedNotionalBreach({
    ...PP27,
    tier: 1,
    protection: { nakedNotionalCapPctOfPool: 30, nakedNotionalCapFloorUsd: 10 },
  });
  assert.equal(r.breached, false, '30% de $353 son $106: $53.90 cabe');
});

// ---------------------------------------------------------------------------
// Fase 3.3 — el escape de riesgo de net_profit tiene que ser alcanzable.
// ---------------------------------------------------------------------------

test('riskToInner ya es alcanzable con la salida superior confirmada', () => {
  // Antes el latch retornaba ANTES de que `riskToInner` se calculara: un escape
  // de riesgo que no podia dispararse en el estado de riesgo. Al dejar de
  // frenar en `upper_exit_latched`, la ruta queda abierta.
  const decision = decideNetProfitV1({
    deltaQty: 0.02,
    actualQty: 0.5,
    currentPrice: 111.5,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    expectedCostUsd: 1,
    lpValueUsd: 100,
    now: 1_000_000,
    state: { upperExitConfirmed: true, upperExitStartedAt: 900_000 },
  });

  assert.equal(decision.decision, 'rebalance');
  assert.equal(decision.gate, 'risk_to_inner');
  assert.ok(decision.adjustQty < 0);
});
