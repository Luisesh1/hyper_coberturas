const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL_RANGE_V1,
  DEFAULT_TERMINAL_CONFIG,
  normalizeTerminalConfig,
  resolveThresholds,
  resolveDirection,
  advanceMinute,
  balancedQty,
  estimateRecenterCostUsd,
  solveTerminalQty,
  outOfRangeQty,
  decideTerminalRangeV1,
  promoteTerminalIntent,
} = require('../src/services/terminal-range-policy.service');

// LP continuo de Uniswap v3 con las formulas de la especificacion (§2). Es la
// referencia contra la que se juzga todo: si la politica usa otra valoracion,
// estos numeros lo delatan.
function makeLp({ lower = 95, upper = 105, capital = 10_000, spot = 100 } = {}) {
  const sa = Math.sqrt(lower);
  const sb = Math.sqrt(upper);
  const unit = (price) => {
    const u = Math.sqrt(Math.min(Math.max(price, lower), upper));
    const x = 1 / u - 1 / sb;
    const y = u - sa;
    return { x, y };
  };
  const u0 = unit(spot);
  const L = capital / (u0.x * spot + u0.y);
  const volatileAt = (price) => L * unit(price).x;
  const valueAt = (price) => {
    const { x, y } = unit(price);
    return L * (x * price + y);
  };
  return { lower, upper, L, valueAt, volatileAt };
}

const MIN = 60_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MIN); // inicio exacto de minuto
const at = (minute, second = 0) => T0 + minute * MIN + second * 1000;

function baseInput(lp, overrides = {}) {
  return {
    valueAt: lp.valueAt,
    volatileAt: lp.volatileAt,
    currentPrice: 100,
    rangeLowerPrice: lp.lower,
    rangeUpperPrice: lp.upper,
    liquidity: '1000',
    actualQty: 0,
    hedgeNetUsd: 0,
    state: {},
    now: at(0, 1),
    config: DEFAULT_TERMINAL_CONFIG,
    minOrderNotionalUsd: 11,
    ...overrides,
  };
}

// Aplica una decision como si la orden se hubiera llenado entera.
function fill(decision, now) {
  return promoteTerminalIntent(decision.nextState, {
    intentId: decision.intentId,
    commandedQty: decision.targetQty,
    now,
  });
}

// Recorre una serie de ticks `[minuto, segundo, precio]` y devuelve la ultima
// decision. Llena todo lo que se decide, como un exchange perfecto.
function run(lp, startState, ticks, { held: startHeld = 0, hedgeNetUsd = 0 } = {}) {
  let state = startState;
  let held = startHeld;
  const decisions = [];
  for (const [minute, second, price] of ticks) {
    const d = decideTerminalRangeV1(baseInput(lp, {
      currentPrice: price, state, actualQty: held, now: at(minute, second), hedgeNetUsd,
    }));
    decisions.push(d);
    if (d.decision === 'rebalance') {
      state = fill(d, at(minute, second));
      held = d.targetQty;
    } else {
      state = d.nextState;
    }
  }
  return { state, held, decisions, last: decisions[decisions.length - 1] };
}

// --- Piezas puras -----------------------------------------------------------

test('umbrales al 40% de la distancia a cada borde (ejemplo de la especificacion)', () => {
  const t = resolveThresholds({ anchor: 100, lower: 95, upper: 105, threshold: 0.4 });
  assert.ok(Math.abs(t.lowerTrigger - 98) < 1e-12);
  assert.ok(Math.abs(t.upperTrigger - 102) < 1e-12);
  // Apertura descentrada: cada umbral conserva el 40% de SU distancia.
  const off = resolveThresholds({ anchor: 97, lower: 95, upper: 105, threshold: 0.4 });
  assert.ok(Math.abs(off.lowerTrigger - 96.2) < 1e-12);
  assert.ok(Math.abs(off.upperTrigger - 100.2) < 1e-12);
});

test('direccion: -1 bajo el umbral inferior, +1 sobre el superior, 0 en la banda central', () => {
  const t = { lowerTrigger: 98, upperTrigger: 102 };
  assert.equal(resolveDirection(98, t), -1);
  assert.equal(resolveDirection(97, t), -1);
  assert.equal(resolveDirection(102, t), 1);
  assert.equal(resolveDirection(100, t), 0);
});

test('config: el perfil aprobado es explicito, no el 20% historico del motor', () => {
  assert.equal(DEFAULT_TERMINAL_CONFIG.threshold, 0.4);
  assert.equal(DEFAULT_TERMINAL_CONFIG.confirmMinutes, 2);
  assert.deepEqual(normalizeTerminalConfig({ threshold: 7, confirmMinutes: -1 }), DEFAULT_TERMINAL_CONFIG);
  assert.equal(normalizeTerminalConfig({ threshold: 0.3 }).threshold, 0.3);
});

test('cierres de minuto: dos ticks en el mismo minuto no son dos cierres', () => {
  let r = advanceMinute(null, 100, at(0, 1));
  assert.equal(r.close, null);
  r = advanceMinute(r.minute, 101, at(0, 30));
  assert.equal(r.close, null, 'mismo minuto: sin cierre');
  r = advanceMinute(r.minute, 99, at(1, 2));
  assert.deepEqual(r.close, { bucket: r.minute.bucket - 1, price: 101 }, 'el cierre es el ultimo precio del minuto');
});

test('secante: sin costes, los residuos de ambos bordes son iguales', () => {
  const lp = makeLp();
  const q = balancedQty({ valueAt: lp.valueAt, lower: 95, upper: 105, spot: 100, execPrice: 100 });
  const B = lp.valueAt(100);
  const resDown = lp.valueAt(95) - B + q * (100 - 95);
  const resUp = lp.valueAt(105) - B + q * (100 - 105);
  assert.ok(Math.abs(resDown - resUp) < 1e-8, `${resDown} vs ${resUp}`);
  assert.ok(q > 0);
});

test('solver: encuentra la raiz con costes y respeta 0 <= q <= qMax', () => {
  const r = solveTerminalQty({
    residualUsd: -200, actualQty: 30, execPrice: 100, edgeExecPrice: 95, costRate: 0.00065, maxQty: 150,
  });
  assert.equal(r.infeasible, false);
  assert.ok(Math.abs(r.residualUsd) < 1e-6);
  assert.ok(r.qty >= 0 && r.qty <= 150);
});

test('solver: sin raiz short-only no abre un long; elige el menor |g| y marca inalcanzable', () => {
  // Borde superior con perdida neta: el short solo la agranda al subir, asi
  // que anularla exigiria un LONG.
  const r = solveTerminalQty({
    residualUsd: -50, actualQty: 30, execPrice: 100, edgeExecPrice: 105, costRate: 0.00065, maxQty: 150,
  });
  assert.equal(r.infeasible, true);
  assert.equal(r.qty, 0);
});

test('coste de recentrado: positivo y menor que el valor en el borde', () => {
  const lp = makeLp();
  const k = estimateRecenterCostUsd({
    edge: 95, valueAtEdge: lp.valueAt(95), volatileAtEdge: lp.volatileAt(95),
    widthFrac: 0.1, gasUsd: 2, swapCostRate: 0.001,
  });
  assert.ok(k > 2, 'al menos el gas');
  assert.ok(k < 20);
});

test('fuera de rango el objetivo es el ETH que queda en el LP', () => {
  const lp = makeLp();
  assert.ok(Math.abs(outOfRangeQty({ volatileAt: lp.volatileAt, spot: 90, execPrice: 90 }) - lp.volatileAt(90)) < 1e-12);
  assert.equal(outOfRangeQty({ volatileAt: lp.volatileAt, spot: 110, execPrice: 110 }), 0);
});

// --- Maquina de estados -----------------------------------------------------

test('apertura: short balanceado por secante, intencion pendiente y lado SIN confirmar', () => {
  const lp = makeLp();
  const d = decideTerminalRangeV1(baseInput(lp));
  assert.equal(d.policyVersion, TERMINAL_RANGE_V1);
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'cycle_open');
  const q = balancedQty({ valueAt: lp.valueAt, lower: 95, upper: 105, spot: 100, execPrice: 100 });
  assert.ok(Math.abs(d.targetQty - q) < 1e-9);
  assert.equal(d.nextState.anchorPrice, 100);
  assert.ok(Math.abs(d.nextState.baselineValueUsd - lp.valueAt(100)) < 1e-9);
  assert.equal(d.nextState.pendingIntent.side, 0);
  assert.equal(d.nextState.side, undefined, 'el lado solo se confirma con el fill');
});

test('promocion: solo la intencion con el mismo id mueve lado y zona', () => {
  const lp = makeLp();
  const d = decideTerminalRangeV1(baseInput(lp));
  const stale = promoteTerminalIntent(d.nextState, { intentId: 'otro', commandedQty: 1, now: at(0, 2) });
  assert.equal(stale.side, undefined);
  assert.ok(stale.pendingIntent, 'sigue pendiente');
  assert.equal(stale.committedTargetQty, 1, 'lo comandado se adopta venga de quien venga');
  const ok = fill(d, at(0, 2));
  assert.equal(ok.side, 0);
  assert.equal(ok.zone, 'inside');
  assert.equal(ok.pendingIntent, null);
});

test('confirmacion: tres cierres consecutivos bajo el umbral; ejecuta en la apertura siguiente', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const r = run(lp, opened.state, [
    [1, 1, 97.9], // cierre m0=100 (central)
    [2, 1, 97.9], // cierre m1=97.9 -> candidato
    [3, 1, 97.9], // cierre m2 -> 1 min
    [3, 40, 97.9], // mismo minuto: nada nuevo
  ], { held: opened.held });
  assert.equal(r.last.decision, 'hold');
  assert.equal(r.last.gate, 'terminal_confirming');
  const fired = run(lp, r.state, [[4, 1, 97.9]], { held: r.held });
  assert.equal(fired.last.decision, 'rebalance');
  assert.equal(fired.last.gate, 'terminal_adjust');
  assert.equal(fired.last.edge, 95);
  assert.equal(fired.state.side, -1);
});

test('volver a la banda central antes de confirmar reinicia la candidatura', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const r = run(lp, opened.state, [
    [1, 1, 97.9], [2, 1, 97.9], [3, 1, 100], [4, 1, 97.9], [5, 1, 97.9],
  ], { held: opened.held });
  // m1, m2 bajo; m3 central (reinicia); m4 bajo (candidato nuevo)
  assert.equal(r.last.gate, 'terminal_confirming');
  assert.equal(r.state.side, 0);
});

test('un minuto sin ticks rompe la racha', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  // Sin ticks en m3: el cierre de m4 no es consecutivo al de m2.
  const r = run(lp, opened.state, [
    [1, 1, 97.9], [2, 1, 97.9], [4, 1, 97.9], [5, 1, 97.9],
  ], { held: opened.held });
  assert.equal(r.last.decision, 'hold');
  assert.equal(r.last.gate, 'terminal_confirming');
});

test('tras ajustar abajo, volver al centro NO restaura el balanceado; revertir exige 102 y conserva N', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const down = run(lp, opened.state, [
    [1, 1, 97.9], [2, 1, 97.9], [3, 1, 97.9], [4, 1, 97.9],
  ], { held: opened.held });
  assert.equal(down.state.side, -1);
  const baseline = down.state.hedgeNetBaselineUsd;
  const center = run(lp, down.state, [[5, 1, 100], [6, 1, 100], [7, 1, 100], [8, 1, 100]], { held: down.held });
  assert.equal(center.last.decision, 'hold');
  assert.equal(center.state.side, -1);
  const up = run(lp, center.state, [
    [9, 1, 102.1], [10, 1, 102.1], [11, 1, 102.1], [12, 1, 102.1],
  ], { held: center.held, hedgeNetUsd: 12 });
  assert.equal(up.decisions.at(-1).gate, 'terminal_adjust');
  assert.equal(up.state.side, 1);
  assert.equal(up.state.hedgeNetBaselineUsd, baseline, 'la reversion no reinicia la contabilidad');
});

test('fuera de rango: un cierre fuera ajusta en el tick siguiente sin confirmacion; quedarse no reajusta', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const out = run(lp, opened.state, [[1, 1, 94], [2, 1, 94]], { held: opened.held });
  const exit = out.decisions[1];
  assert.equal(exit.decision, 'rebalance');
  assert.equal(exit.gate, 'range_exit');
  assert.ok(Math.abs(exit.targetQty - lp.volatileAt(94)) < 1e-9);
  const stay = run(lp, out.state, [[3, 1, 93], [4, 1, 92]], { held: out.held });
  assert.equal(stay.last.decision, 'hold');
  assert.equal(stay.last.gate, 'outside_hold');
});

test('reentrada a la banda central restaura el balanceado con lado neutro', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const out = run(lp, opened.state, [[1, 1, 94], [2, 1, 94]], { held: opened.held });
  const back = run(lp, out.state, [[3, 1, 100], [4, 1, 100]], { held: out.held });
  assert.equal(back.last.gate, 'range_reentry');
  assert.equal(back.state.side, 0);
  const q = balancedQty({ valueAt: lp.valueAt, lower: 95, upper: 105, spot: 100, execPrice: 100 });
  assert.ok(Math.abs(back.held - q) < 1e-9);
});

test('reentrada a una banda terminal recalcula hacia ese borde', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const out = run(lp, opened.state, [[1, 1, 94], [2, 1, 94]], { held: opened.held });
  const back = run(lp, out.state, [[3, 1, 96], [4, 1, 96]], { held: out.held });
  assert.equal(back.last.gate, 'range_reentry');
  assert.equal(back.state.side, -1);
  assert.equal(back.last.edge, 95);
});

test('rango nuevo (re-centrado) abre ciclo con baseline nuevo', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]], { hedgeNetUsd: 5 });
  const lp2 = makeLp({ lower: 90, upper: 100, spot: 95 });
  const d = decideTerminalRangeV1(baseInput(lp2, {
    currentPrice: 95, state: opened.state, actualQty: opened.held, now: at(5, 1), hedgeNetUsd: 40,
  }));
  assert.equal(d.gate, 'cycle_rebased');
  assert.equal(d.nextState.anchorPrice, 95);
  assert.equal(d.nextState.hedgeNetBaselineUsd, 40);
  assert.equal(d.nextState.cycleId, opened.state.cycleId + 1);
});

test('cambio de liquidez: el aporte de capital no cuenta como PnL', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const doubled = { ...lp, valueAt: (p) => 2 * lp.valueAt(p), volatileAt: (p) => 2 * lp.volatileAt(p) };
  const d = decideTerminalRangeV1(baseInput(doubled, {
    state: opened.state, actualQty: opened.held, liquidity: '2000', now: at(1, 1), forceRebalance: true,
  }));
  assert.ok(Math.abs(d.nextState.baselineValueUsd - 2 * lp.valueAt(100)) < 1e-6);
  assert.equal(d.gate, 'forced');
  assert.ok(Math.abs(d.targetQty - 2 * opened.held) < 1e-6, 'el balanceado escala con el LP');
});

test('orden que no aterrizo: se reintenta si supera el minimo; si no, se nombra aparte', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const retry = decideTerminalRangeV1(baseInput(lp, {
    state: opened.state, actualQty: opened.held * 0.5, now: at(0, 20),
  }));
  assert.equal(retry.gate, 'commit_incomplete');
  assert.ok(Math.abs(retry.targetQty - opened.held) < 1e-9);
  const tiny = decideTerminalRangeV1(baseInput(lp, {
    state: opened.state, actualQty: opened.held - 1.5, now: at(0, 20), minOrderNotionalUsd: 500,
  }));
  assert.equal(tiny.decision, 'hold');
  assert.equal(tiny.gate, 'commit_below_min_notional');
});

test('intencion sin fill se reemite en el tick siguiente', () => {
  const lp = makeLp();
  const d = decideTerminalRangeV1(baseInput(lp));
  const again = decideTerminalRangeV1(baseInput(lp, { state: d.nextState, now: at(0, 3) }));
  assert.equal(again.decision, 'rebalance');
  assert.equal(again.gate, 'pending_retry');
  assert.equal(again.intentId, d.intentId);
});

test('sin rango utilizable se queda quieta', () => {
  const lp = makeLp();
  const d = decideTerminalRangeV1(baseInput(lp, { rangeLowerPrice: 0 }));
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'range_unavailable');
});

test('intencion ya cumplida por la posicion (bajo el minimo): se confirma con lo que hay, sin bucle', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  // Estado pendiente cuyo objetivo esta a menos del minimo de lo que ya hay.
  const pendiente = decideTerminalRangeV1(baseInput(lp, {
    state: opened.state, actualQty: opened.held, now: at(0, 10), forceRebalance: true,
  }));
  assert.equal(pendiente.decision, 'hold', 'un ajuste de centavos no se manda');
  assert.equal(pendiente.gate, 'intent_within_min_notional');
  assert.equal(pendiente.nextState.pendingIntent, null, 'no queda una intencion que reintentar sin fin');
  assert.equal(pendiente.nextState.side, 0);
  assert.equal(pendiente.nextState.committedTargetQty, opened.held, 'lo confirmado es lo que hay');
});

test('cierre total por encima del rango se manda aunque sea sub-minimo', () => {
  const lp = makeLp();
  const opened = run(lp, {}, [[0, 1, 100]]);
  const d = decideTerminalRangeV1(baseInput(lp, {
    currentPrice: 106, state: { ...opened.state, minute: { bucket: Math.floor(at(1, 1) / MIN), lastPrice: 106 } },
    actualQty: 0.05, now: at(2, 1),
  }));
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'range_exit');
  assert.equal(d.targetQty, 0);
});
