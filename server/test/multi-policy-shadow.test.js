const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_POLICIES,
  resolveLivePolicy,
  resolveShadowPolicies,
  readPersistedShadow,
  scaleFundingToShadow,
  runShadowPolicies,
  buildShadowSnapshots,
} = require('../src/services/protected-pool-delta-neutral/shadow-policies');
const { estimateExecutionCostUsd } = require('../src/services/protected-pool-delta-neutral.helpers');
const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

const LEGACY = 'legacy_zones_v1';
const V1 = 'net_profit_v1';
const V2 = 'net_profit_v2';

// Set historico de multiplicadores. Se inyecta explicitamente porque los
// vigentes se overridean por env: un test que asuma un valor concreto
// verificaria el .env de la maquina, no la logica.
const MULTIPLIERS = { center: 0.6, transition: 0.85, edge: 1 };

function shadowArgs(overrides = {}) {
  return {
    protectionId: 77,
    memory: new Map(),
    strategyState: {},
    declaredPolicy: LEGACY,
    livePolicy: LEGACY,
    liveActualQty: 0,
    deltaQty: 1,
    currentPrice: 2500,
    bid: 2499.5,
    ask: 2500.5,
    feeRate: 0.00045,
    realFundingUsd: 0,
    now: 1_800_000_000_000,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    lpValueUsd: 5000,
    targetHedgeRatio: 1,
    zoneState: 'center',
    multipliers: MULTIPLIERS,
    effectiveBandPct: 1,
    intervalSec: 3600,
    minRebalanceNotionalUsd: 11,
    urgentMinNotionalUsd: 11,
    centerDeadZone: { pct: 0, active: false, positionPct: 0.5 },
    forceReason: null,
    forceRebalance: false,
    ...overrides,
  };
}

// ── Seleccion de la politica viva y sus dos sombras ────────────────────────

test('la viva es legacy salvo que una net_profit este declarada como live', () => {
  assert.equal(resolveLivePolicy({ policyVersion: LEGACY, executionIntent: 'live' }), LEGACY);
  assert.equal(resolveLivePolicy({ policyVersion: V1, executionIntent: 'live' }), V1);
  assert.equal(resolveLivePolicy({ policyVersion: V2, executionIntent: 'live' }), V2);
  // Intencion sombra: ejecuta legacy y net_profit pasa a ser una de las dos
  // sombras. Es la combinacion que ya existia antes de esta feature.
  assert.equal(resolveLivePolicy({ policyVersion: V1, executionIntent: 'shadow' }), LEGACY);
  assert.equal(resolveLivePolicy({}), LEGACY);
});

test('sea cual sea la viva, siempre quedan exactamente las otras dos en sombra', () => {
  for (const live of ALL_POLICIES) {
    const shadows = resolveShadowPolicies(live);
    assert.equal(shadows.length, 2, `con ${live} viva deben quedar dos sombras`);
    assert.ok(!shadows.includes(live));
    assert.deepEqual([...shadows, live].sort(), [...ALL_POLICIES].sort());
  }
});

// ── El riesgo central: la sombra legacy NO puede copiar a la viva ──────────

test('bajo una proteccion net_profit, la sombra legacy deriva su propio target y NO el del motor', () => {
  // Con net_profit viva el target del motor es el delta completo (ratio 1, sin
  // escalones de zona). La sombra legacy tiene que aplicar el escalon de su
  // zona: si copiara `metrics.targetQty` las tres lineas de la grafica saldrian
  // superpuestas y la comparativa no diria nada.
  const [legacyShadow] = runShadowPolicies(shadowArgs({
    livePolicy: V1,
    declaredPolicy: V1,
    zoneState: 'center',
    deltaQty: 2,
  })).filter((r) => r.policyVersion === LEGACY);

  const liveTargetQty = 2; // ratio 1 bajo net_profit live
  assert.equal(legacyShadow.targetQty, 2 * MULTIPLIERS.center);
  assert.notEqual(legacyShadow.targetQty, liveTargetQty);
});

test('la sombra legacy escalona por zona: centro y transicion difieren del vivo, edge coincide', () => {
  const targetPara = (zoneState) => runShadowPolicies(shadowArgs({
    livePolicy: V1, declaredPolicy: V1, zoneState, deltaQty: 2,
  })).find((r) => r.policyVersion === LEGACY).targetQty;

  assert.equal(targetPara('center'), 2 * MULTIPLIERS.center);
  assert.equal(targetPara('transition'), 2 * MULTIPLIERS.transition);
  // En 'edge' el multiplicador es 1 y coincidir con el vivo es CORRECTO: ahi
  // las dos politicas piden lo mismo. Por eso el test de arriba mira 'center'.
  assert.equal(targetPara('edge'), 2);
});

test('la sombra legacy mide el movimiento de precio contra SU propio ultimo rebalanceo', () => {
  const now = 1_800_000_000_000;
  // Estado persistido de la sombra legacy: rebalanceo reciente a 2000, asi que
  // el temporizador no vence. Si leyera el `lastRebalanceAt` de la raiz (el de
  // la ejecucion real, de hace 13 h) dispararia por temporizador.
  const strategyState = {
    lastRebalanceAt: now - (13 * 60 * 60_000),
    shadowSnapshots: {
      [LEGACY]: {
        actualQty: 1,
        averageEntryPrice: 2000,
        shadowPolicyState: { lastRebalanceAt: now - 1000, lastSnapshotPrice: 2000 },
      },
    },
  };
  const [legacyShadow] = runShadowPolicies(shadowArgs({
    livePolicy: V1,
    declaredPolicy: V1,
    memory: new Map(),
    strategyState,
    now,
    deltaQty: 1,
    zoneState: 'edge',
    effectiveBandPct: 90,
  })).filter((r) => r.policyVersion === LEGACY);

  assert.equal(legacyShadow.gate, 'timer_not_due');
  assert.equal(legacyShadow.decision, 'hold');
});

// ── Acumulacion independiente por politica ────────────────────────────────

test('con cualquier politica viva, las otras dos acumulan estado propio e independiente', () => {
  for (const live of ALL_POLICIES) {
    const memory = new Map();
    const base = shadowArgs({
      memory, livePolicy: live, declaredPolicy: live, liveActualQty: 0, deltaQty: 1,
    });
    const primero = runShadowPolicies(base);
    assert.equal(primero.length, 2);

    // Segundo tick: mismo estado de mercado, media hora despues.
    const segundo = runShadowPolicies({ ...base, now: base.now + 1_800_000 });
    assert.equal(segundo.length, 2);

    const claves = segundo.map((r) => r.policyVersion).sort();
    assert.deepEqual(claves, resolveShadowPolicies(live).sort());
    // Cada politica tiene su propia entrada en memoria: nada compartido.
    for (const result of segundo) {
      assert.ok(memory.has(`77:${result.policyVersion}`));
    }
    assert.equal(memory.size, 2, `con ${live} viva solo se guardan las dos sombras`);
  }
});

test('las comisiones se acumulan tick a tick en vez de reflejar solo el ultimo', () => {
  const memory = new Map();
  const base = shadowArgs({ memory, livePolicy: LEGACY, declaredPolicy: LEGACY, zoneState: 'edge' });
  const primero = runShadowPolicies(base).find((r) => r.policyVersion === V1);
  // Segundo tick con el delta al doble: obliga a otro ajuste.
  const segundo = runShadowPolicies({ ...base, now: base.now + 86_400_000, deltaQty: 2 })
    .find((r) => r.policyVersion === V1);

  assert.ok(primero.state.executionFeesUsd > 0, 'el primer ajuste paga fee');
  assert.ok(
    segundo.state.executionFeesUsd > primero.state.executionFeesUsd,
    'el fee del segundo tick se suma al del primero, no lo reemplaza'
  );
});

test('v1 y v2 corren a la vez y su presupuesto diario las separa', () => {
  // Con legacy viva, las dos net_profit se simulan en el mismo tick. V2 tiene
  // tope de rotaciones/dia; V1 no. Partiendo del mismo estado, el tope solo
  // puede frenar a V2.
  const memory = new Map();
  // LP grande a proposito: con el error por encima del 15% del LP las dos
  // entran por `risk_to_inner`, que corrige igual en ambas y las volveria
  // indistinguibles por diseno, no por un bug.
  const base = shadowArgs({
    memory, livePolicy: LEGACY, declaredPolicy: LEGACY, zoneState: 'edge', deltaQty: 1,
    lpValueUsd: 100_000,
  });
  const resultados = runShadowPolicies(base);
  const v1 = resultados.find((r) => r.policyVersion === V1);
  const v2 = resultados.find((r) => r.policyVersion === V2);

  assert.ok(v1 && v2, 'v1 y v2 se evaluan en el mismo tick');
  // V2 corrige mas agresivo (75% del error contra 50% de V1) sobre el mismo
  // punto de partida: son dos simulaciones distintas, no la misma repetida.
  assert.notEqual(v1.state.actualQty, v2.state.actualQty);
  assert.equal(v2.policyState.rotationBudgetCount, 1);
  assert.equal(v1.policyState.rotationBudgetCount, undefined);
});

// ── Persistencia: migracion del formato viejo sin inventar historia ────────

test('un shadowSnapshot viejo (singular) se lee como la politica que era sombra entonces', () => {
  const strategyState = {
    policyVersion: V1,
    shadowSnapshot: { actualQty: 3, realizedPnlUsd: 12, executionFeesUsd: 4, averageEntryPrice: 2400 },
    shadowPolicyState: { lastFillAt: 5 },
    shadowFundingSourceUsd: 7,
  };

  const migrado = readPersistedShadow(strategyState, V1, V1);
  assert.equal(migrado.actualQty, 3);
  assert.equal(migrado.realizedPnlUsd, 12);
  assert.deepEqual(migrado.shadowPolicyState, { lastFillAt: 5 });
  assert.equal(migrado.shadowFundingSourceUsd, 7);
});

test('las politicas que nadie midio entran como hueco, jamas como cero', () => {
  const strategyState = {
    policyVersion: V1,
    shadowSnapshot: { actualQty: 3, realizedPnlUsd: 12 },
  };
  // El snapshot singular era de V1: ni V2 ni legacy pueden reclamarlo, y
  // tampoco se les inventa un cero (un cero dibujaria una politica plana y se
  // leeria como "no rinde" cuando lo cierto es "no se midio").
  assert.equal(readPersistedShadow(strategyState, V2, V1), null);
  assert.equal(readPersistedShadow(strategyState, LEGACY, V1), null);
});

test('el formato nuevo por politica gana sobre el singular', () => {
  const strategyState = {
    policyVersion: V1,
    shadowSnapshot: { actualQty: 3 },
    shadowSnapshots: { [V1]: { actualQty: 9 } },
  };
  assert.equal(readPersistedShadow(strategyState, V1, V1).actualQty, 9);
});

test('buildShadowSnapshots indexa por politica con su policyState y su funding', () => {
  // `liveActualQty: 2` con las sombras arrancando en frio desde ahi: el factor
  // de reparto del funding vale 1 y el importe llega integro.
  const snapshots = buildShadowSnapshots(runShadowPolicies(shadowArgs({
    livePolicy: V2, declaredPolicy: V2, zoneState: 'edge', realFundingUsd: -3,
    liveActualQty: 2, deltaQty: 2,
  })));

  assert.deepEqual(Object.keys(snapshots).sort(), [LEGACY, V1].sort());
  assert.equal(snapshots[V2], undefined, 'la politica viva no se simula: ya se midio');
  for (const policy of [LEGACY, V1]) {
    assert.ok('shadowPolicyState' in snapshots[policy]);
    assert.equal(snapshots[policy].shadowFundingSourceUsd, -3);
    assert.equal(snapshots[policy].fundingUsd, -3);
  }
});

// ── Coste del tick: cero llamadas de red ──────────────────────────────────

// Este test intercepta las primitivas REALES de red. Un intento anterior
// pasaba dobles como claves extra del objeto de entrada, pero
// `runShadowPolicies` destructura una lista fija y esas claves no se leen
// nunca: eran objetos muertos que no podian explotar aunque el modulo hiciera
// IO. Aqui se sabotea `fetch`, `http/https.request` y `net.Socket.connect`,
// que es por donde tendria que salir cualquier llamada de verdad.
test('evaluar las sombras no hace ninguna llamada de red', () => {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const original = {
    fetch: global.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    connect: net.Socket.prototype.connect,
  };
  const intentos = [];
  const sabotear = (nombre) => () => {
    intentos.push(nombre);
    throw new Error(`la sombra no puede usar ${nombre}`);
  };
  global.fetch = sabotear('fetch');
  http.request = sabotear('http.request');
  https.request = sabotear('https.request');
  net.Socket.prototype.connect = sabotear('net.connect');

  let resultados;
  try {
    resultados = runShadowPolicies(shadowArgs({ livePolicy: LEGACY }));
  } finally {
    global.fetch = original.fetch;
    http.request = original.httpRequest;
    https.request = original.httpsRequest;
    net.Socket.prototype.connect = original.connect;
  }

  assert.deepEqual(intentos, [], `la sombra intento salir a red: ${intentos.join(', ')}`);
  assert.equal(resultados.length, 2);
  // Sincrono por construccion: si algo hiciera IO habria que esperarlo, asi que
  // devolver un array y no una promesa es la prueba estructural de que no lo hay.
  assert.ok(!(resultados instanceof Promise), 'runShadowPolicies no puede ser asincrona');
  // Y el resultado no contiene nada ejecutable: solo estado y diagnostico.
  for (const result of resultados) {
    assert.deepEqual(
      Object.keys(result).sort(),
      ['decision', 'fundingSourceUsd', 'gate', 'log', 'minNotionalUsd', 'policyState', 'policyVersion', 'state', 'targetQty'],
    );
  }
});

// ── Gates de ejecucion: la sombra simula la politica CORRIENDO VIVA ────────
// Sin estos gates la sombra mediria "esta politica si nada la frenara":
// rebalancearia de mas, pagaria menos comisiones de las que deberia lucir y
// mostraria un tracking que la version real nunca consigue.

test('el dwell minimo frena a la sombra igual que a la ruta viva', () => {
  const now = 1_800_000_000_000;
  const base = shadowArgs({
    now, livePolicy: V1, declaredPolicy: V1, zoneState: 'edge',
    deltaQty: 2, liveActualQty: 1, minDwellMs: 60_000,
    strategyState: {
      shadowSnapshots: {
        [LEGACY]: {
          actualQty: 1,
          averageEntryPrice: 2500,
          // Fill simulado hace 10 s: dentro del dwell de 60 s.
          shadowPolicyState: { minDwellUntil: now + 50_000 },
        },
      },
    },
  });
  const frenada = runShadowPolicies(base).find((r) => r.policyVersion === LEGACY);

  assert.equal(frenada.gate, 'min_dwell_active');
  assert.equal(frenada.decision, 'hold');
  assert.equal(frenada.state.actualQty, 1, 'con el dwell activo la posicion no se mueve');
  assert.equal(frenada.state.executionFeesUsd, 0, 'ni paga comisiones');
});

test('tras llenar, la sombra se pone su propio dwell', () => {
  const now = 1_800_000_000_000;
  const llena = runShadowPolicies(shadowArgs({
    now, livePolicy: V1, declaredPolicy: V1, zoneState: 'edge',
    deltaQty: 2, liveActualQty: 0, minDwellMs: 60_000,
  })).find((r) => r.policyVersion === LEGACY);

  assert.equal(llena.decision, 'rebalance');
  assert.equal(llena.policyState.minDwellUntil, now + 60_000);
});

test('la banda de coste frena a la sombra legacy cuando la correccion no la paga', () => {
  const now = 1_800_000_000_000;
  // Deriva de $20: la politica legacy dispara (su piso esta en $1) pero la
  // banda de coste de la ejecucion exige $50.
  const base = shadowArgs({
    now, livePolicy: V1, declaredPolicy: V1, zoneState: 'edge',
    deltaQty: 1.008, liveActualQty: 1,
    minRebalanceNotionalUsd: 1, urgentMinNotionalUsd: 1,
    strategyState: {
      shadowSnapshots: {
        [LEGACY]: { actualQty: 1, averageEntryPrice: 2500, shadowPolicyState: {} },
      },
    },
  });

  const frenada = runShadowPolicies({ ...base, minOrderNotionalUsd: 50 })
    .find((r) => r.policyVersion === LEGACY);
  assert.equal(frenada.gate, 'within_cost_aware_band');
  assert.equal(frenada.state.actualQty, 1);

  // Control: con la banda por debajo de la deriva, la misma entrada si ejecuta.
  const pasa = runShadowPolicies({ ...base, minOrderNotionalUsd: 5 })
    .find((r) => r.policyVersion === LEGACY);
  assert.equal(pasa.decision, 'rebalance');
  assert.ok(pasa.state.actualQty > 1);
});

test('un forzado del orquestador atraviesa la banda de coste, como en vivo', () => {
  const base = shadowArgs({
    livePolicy: V1, declaredPolicy: V1, zoneState: 'edge',
    deltaQty: 1.008, liveActualQty: 1, minOrderNotionalUsd: 50,
    minRebalanceNotionalUsd: 1, urgentMinNotionalUsd: 1,
    strategyState: {
      shadowSnapshots: {
        [LEGACY]: { actualQty: 1, averageEntryPrice: 2500, shadowPolicyState: {} },
      },
    },
  });
  const forzada = runShadowPolicies({ ...base, forceRebalance: true })
    .find((r) => r.policyVersion === LEGACY);

  assert.notEqual(forzada.gate, 'within_cost_aware_band');
  assert.equal(forzada.decision, 'rebalance');
});

// La asimetria es DELIBERADA y fiel a la ruta viva, no un olvido: bajo
// net_profit la `rebalanceDecision` se sintetiza de la propia politica y su
// equivalente economico ya vive dentro de `decideNetProfitV1`. Aplicarles
// ademas la banda legacy las volveria mas conservadoras que su version viva.
test('la banda de coste NO se aplica a las sombras net_profit', () => {
  const resultados = runShadowPolicies(shadowArgs({
    livePolicy: LEGACY, declaredPolicy: LEGACY, zoneState: 'edge',
    deltaQty: 1, liveActualQty: 0, minOrderNotionalUsd: 1_000_000,
    lpValueUsd: 100_000,
  }));

  for (const policy of [V1, V2]) {
    const result = resultados.find((r) => r.policyVersion === policy);
    assert.notEqual(result.gate, 'within_cost_aware_band', `${policy} no debe sufrir la banda legacy`);
    assert.equal(result.decision, 'rebalance');
  }
});

// ── Funding proporcional a la posicion contrafactual ──────────────────────

test('el funding se reparte por tamano de posicion, no integro a cada sombra', () => {
  // Sombra legacy con la mitad de posicion que la viva: le toca la mitad del
  // funding. Imputarle el integro premia sistematicamente a quien cubre menos,
  // que es siempre legacy — el incumbente que esto viene a poner a prueba.
  const [legacyShadow] = runShadowPolicies(shadowArgs({
    livePolicy: V1, declaredPolicy: V1, zoneState: 'edge',
    deltaQty: 1, liveActualQty: 2, realFundingUsd: -10,
    strategyState: {
      shadowSnapshots: {
        [LEGACY]: {
          actualQty: 1, averageEntryPrice: 2500,
          shadowPolicyState: {}, shadowFundingSourceUsd: 0,
        },
      },
    },
  })).filter((r) => r.policyVersion === LEGACY);

  assert.equal(legacyShadow.state.fundingUsd, -5);
});

test('sin posicion viva no hay funding observado que repartir', () => {
  assert.equal(scaleFundingToShadow(-10, 1, 0), 0);
  assert.equal(scaleFundingToShadow(-10, 1, null), 0);
  // Y el reparto es proporcional en ambos sentidos.
  assert.equal(scaleFundingToShadow(-10, 2, 1), -20);
  assert.equal(scaleFundingToShadow(0, 5, 1), 0);
});

// ── El estimador de coste que reporta la politica ─────────────────────────

test('la sombra net_profit reporta el MISMO piso que su version viva', () => {
  // El piso es `max(11, 3*costeEsperado)`. La sombra estimaba el coste con
  // 0.0005 mientras la ruta viva usa `estimateExecutionCostUsd` (0.00025), asi
  // que la misma politica REPORTABA dos umbrales distintos segun donde
  // corriera. Con error de $25.000 los dos estimadores se separan de verdad
  // (18,75 contra 37,50) y este test se cae si alguien revierte el arreglo.
  const errorUsd = 10 * 2500;
  const esperado = Math.max(11, 3 * estimateExecutionCostUsd(10, 2500));
  assert.equal(esperado, 18.75);

  const [v1] = runShadowPolicies(shadowArgs({
    livePolicy: LEGACY, declaredPolicy: LEGACY, zoneState: 'edge',
    deltaQty: 10, liveActualQty: 0, lpValueUsd: 10_000_000,
  })).filter((r) => r.policyVersion === V1);

  assert.equal(v1.minNotionalUsd, esperado);
  assert.notEqual(v1.minNotionalUsd, Math.max(11, 3 * errorUsd * 0.0005));
});

// ── Puente motor -> contabilidad ──────────────────────────────────────────
// No habia ningun test que uniera lo que el motor ESCRIBE con lo que la
// contabilidad LEE: los de `lp-orchestrator-accounting.test.js` usan fixtures
// fabricadas, asi que el camino podia quedar muerto sin que nada se pusiera
// rojo. Al pasar de `shadowSnapshot` a `shadowSnapshots` eso es exactamente lo
// que ocurrio.

test('la contabilidad sigue leyendo la sombra despues del cambio de formato', () => {
  const accounting = require('../src/services/lp-orchestrator/accounting');
  const protection = {
    strategyState: {
      policyVersion: V1,
      shadowSnapshots: {
        [V1]: { realizedPnlUsd: 12, unrealizedPnlUsd: -3, fundingUsd: 1, executionFeesUsd: 2, slippageUsd: 0.5 },
      },
    },
  };

  const leido = accounting.readShadowStateFromProtection(protection);
  assert.ok(leido, 'sin esto la pata contrafactual se sobreescribe con 0 en base');
  assert.equal(leido.realizedPnlUsd, 12);
  assert.equal(leido.unrealizedPnlUsd, -3);

  // Y el baseline sobrevive: es lo que impide que el acumulado se descarte.
  const { shadowBaseline } = accounting.applyShadowStateDelta({}, null, leido);
  assert.ok(shadowBaseline, 'un baseline nulo tira el acumulado de toda la ventana');
});

// ── Integracion contra el motor real ──────────────────────────────────────

const PRICE = 2500;

function buildProtection(overrides = {}) {
  return {
    id: 77,
    userId: 1,
    accountId: 8,
    status: 'active',
    protectionMode: 'delta_neutral',
    inferredAsset: 'ETH',
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: '123',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    leverage: 7,
    targetHedgeRatio: 1,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
    minOrderNotionalUsd: 11,
    centerDeadZonePct: 0,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
    },
    poolSnapshot: {
      mode: 'lp_position',
      version: 'v3',
      network: 'arbitrum',
      identifier: '123',
      positionIdentifier: '123',
      owner: '0x00000000000000000000000000000000000000AA',
      creator: '0x00000000000000000000000000000000000000AA',
      poolAddress: '0x00000000000000000000000000000000000000BB',
      token0Address: '0x00000000000000000000000000000000000000CC',
      token1Address: '0x00000000000000000000000000000000000000DD',
      token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000CC', decimals: 18 },
      token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000DD', decimals: 6 },
      tickLower: 74000,
      tickUpper: 79000,
      liquidity: '2000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0.01,
      unclaimedFees1: 12,
      snapshotFreshAt: Date.now(),
    },
    ...overrides,
  };
}

function buildService(protection, { onOrder, actualQty = 0.0001 } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    centerDeadZonePct: 0,
    zoneHedgeMultipliers: MULTIPLIERS,
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        protection.strategyState = payload.strategyState;
      },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({
          coin: 'ETH',
          szi: String(-actualQty),
          leverage: { type: 'isolated', value: 7 },
          cumFunding: { sinceOpen: -1.5 },
        }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    // Cualquier sombra que intente mandar una orden pasa por aqui.
    getTradingService: async () => new Proxy({}, {
      get: (_target, prop) => {
        // `await` sondea `then` sobre el resultado: eso no es una orden.
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        onOrder?.(String(prop));
        return () => { throw new Error(`una sombra no puede llamar a TradingService.${String(prop)}`); };
      },
    }),
    marketService: { getAssetContexts: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    hyperliquidStreamService: {
      trackProtection: () => {},
      start: () => {},
      stop: () => {},
      getMidPrice: async () => null,
      getBbo: async () => null,
      getActiveAssetCtx: async () => null,
      getClearinghouseState: async () => null,
      getDiagnostics: () => ({ enabled: false }),
    },
    rpcBudgetManager: {
      canSpend: () => ({ allowed: true, snapshot: null }),
      getSnapshot: () => null,
      record: () => {},
    },
  });
  service._fetchSpot = async () => ({ priceCurrent: PRICE });
  return service;
}

test('el motor acumula sombra para las DOS politicas no vivas y persiste indexado', async () => {
  const protection = buildProtection();
  const service = buildService(protection);
  let ejecutado = null;
  service._executeRebalance = async ({ strategyState, reason }) => {
    ejecutado = reason;
    return { ...strategyState, executed: true };
  };

  await service.evaluateProtection(protection);

  const snapshots = protection.strategyState.shadowSnapshots;
  assert.ok(snapshots, 'el motor tiene que persistir shadowSnapshots');
  assert.deepEqual(Object.keys(snapshots).sort(), [V1, V2].sort());
  assert.equal(snapshots[LEGACY], undefined, 'legacy es la viva: no se simula');
  assert.equal(protection.strategyState.shadowSnapshot, undefined, 'el formato singular desaparece');
  assert.ok(ejecutado, 'la politica viva si ejecuta');
});

test('con net_profit viva, la sombra legacy se acumula y no copia al target vivo', async () => {
  const protection = buildProtection({
    policyVersion: V1,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
      executionIntent: 'live',
      policyVersion: V1,
    },
  });
  const service = buildService(protection);
  service._executeRebalance = async ({ strategyState }) => ({ ...strategyState, executed: true });

  await service.evaluateProtection(protection);

  const snapshots = protection.strategyState.shadowSnapshots;
  assert.deepEqual(Object.keys(snapshots).sort(), [LEGACY, V2].sort());
  // 2500 sobre 2000-3000 cae en zona 'center': el escalon legacy (0.6) tiene
  // que separar a la sombra del target vivo, que va al 100% del delta.
  assert.equal(protection.strategyState.zoneState, 'center');
  assert.notEqual(
    snapshots[LEGACY].actualQty,
    Number(protection.strategyState.lastTargetQty),
    'la sombra legacy no puede terminar en el mismo target que la viva'
  );
});

test('ninguna sombra toca TradingService', async () => {
  const protection = buildProtection();
  const tocadas = [];
  const service = buildService(protection, { onOrder: (prop) => tocadas.push(prop) });
  // Sin ejecucion real: si algo llama al TradingService, es una sombra.
  service._executeRebalance = async ({ strategyState }) => strategyState;

  await service.evaluateProtection(protection);

  assert.deepEqual(tocadas, [], `una sombra llamo a TradingService: ${tocadas.join(', ')}`);
});
