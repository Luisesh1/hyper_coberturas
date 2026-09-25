/**
 * Politica de cobertura TERMINAL (`terminal_range_v1`).
 *
 * Idea: el short no persigue el delta ni busca paridad dentro del rango. Busca
 * que, AL LLEGAR A UN BORDE, el PnL en dolares del ciclo —LP + hedge + funding
 * menos los costes de cerrar y reabrir— quede en cero. Por eso:
 *
 *   - abre con el short BALANCEADO: la secante (V(b)-V(a))/(b-a), que iguala
 *     los residuos de los dos bordes (no los anula: un short fijo no puede con
 *     un LP no lineal);
 *   - tras un desplazamiento CONFIRMADO hacia un borde, redimensiona para ese
 *     borde resolviendo g(q)=0 con todo lo acumulado del ciclo;
 *   - fuera del rango cubre el ETH que queda en el LP (abajo) o cierra (arriba).
 *
 * El cero es un objetivo condicionado, no una garantia: con short-only y
 * margen finito hay bordes sin raiz, y entonces se elige el menor residuo y se
 * marca `infeasible`.
 *
 * Diferencias deliberadas con `range_exit_v1`, que se le parece por fuera: aquel
 * cubre el 100% del delta y solo se mueve en los bordes; esta nunca va al delta,
 * decide a un 40% del camino al borde y arrastra la contabilidad del ciclo.
 *
 * Todo aqui es aritmetica pura. La valoracion del LP entra como funciones
 * (`valueAt`, `volatileAt`) para no depender del snapshot de Uniswap: el
 * adaptador del motor las construye sobre la posicion real, y los tests con las
 * formulas continuas de la especificacion.
 *
 * Especificacion y decisiones: docs/superpowers/specs/2026-09-25-terminal-range-v1-design.md
 */

const TERMINAL_RANGE_V1 = 'terminal_range_v1';

// Perfil aprobado (optimizacion del 2026-09-25). Se pasa SIEMPRE explicito: el
// motor del backtest tenia 0.2 por defecto y confiar en un default historico es
// como se termina operando otro perfil sin saberlo.
const DEFAULT_TERMINAL_CONFIG = Object.freeze({
  threshold: 0.4,
  confirmMinutes: 2,
  // Comision (4,5 bps) + slippage (2 bps) del hedge, por notional modificado.
  hedgeCostRate: 0.00065,
  // Fee (5 bps) + slippage (5 bps) del swap al recomponer el LP.
  swapCostRate: 0.001,
  gasUsd: 2,
  maxHedge: 1.5,
});

const MINUTE_MS = 60_000;
const SOLVER_ITERATIONS = 70;
const SOLVER_TOLERANCE_USD = 1e-8;
const RECENTER_ITERATIONS = 30;
// Mismas tolerancias que `range_exit_v1` para juzgar si la orden aterrizo:
// cubre el redondeo del exchange sin tapar un llenado parcial.
const COMMIT_TOLERANCE_PCT = 0.02;
const RESIDUAL_QTY = 1e-8;

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTerminalConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const pick = (key, valid) => {
    const n = finite(c[key]);
    return n != null && valid(n) ? n : DEFAULT_TERMINAL_CONFIG[key];
  };
  return {
    threshold: pick('threshold', (n) => n > 0 && n < 1),
    confirmMinutes: pick('confirmMinutes', (n) => Number.isInteger(n) && n >= 0 && n <= 60),
    hedgeCostRate: pick('hedgeCostRate', (n) => n >= 0 && n < 0.05),
    swapCostRate: pick('swapCostRate', (n) => n >= 0 && n < 0.05),
    gasUsd: pick('gasUsd', (n) => n >= 0),
    maxHedge: pick('maxHedge', (n) => n > 0 && n <= 5),
  };
}

function rangeKey(lower, upper) {
  const a = finite(lower);
  const b = finite(upper);
  if (!(a > 0 && b > a)) return null;
  return `${a.toFixed(8)}:${b.toFixed(8)}`;
}

function resolveZone(price, lower, upper) {
  if (price <= lower) return 'below';
  if (price >= upper) return 'above';
  return 'inside';
}

function resolveThresholds({ anchor, lower, upper, threshold }) {
  return {
    lowerTrigger: anchor - threshold * (anchor - lower),
    upperTrigger: anchor + threshold * (upper - anchor),
  };
}

function resolveDirection(price, { lowerTrigger, upperTrigger }) {
  if (price <= lowerTrigger) return -1;
  if (price >= upperTrigger) return 1;
  return 0;
}

/**
 * Deriva cierres de vela de 1 minuto a partir de ticks.
 *
 * El monitor corre cada ~2 s y el backtest confirma sobre cierres de minuto:
 * contar ticks como minutos haria que dos ticks valieran por dos velas. El
 * cierre de un minuto es el ultimo precio visto en el, y solo se conoce al
 * llegar el primer tick del minuto siguiente — que es justo la "apertura
 * siguiente" en la que el backtest ejecuta.
 */
function advanceMinute(minute, price, now) {
  const bucket = Math.floor(now / MINUTE_MS);
  const prior = minute && typeof minute === 'object' ? minute : null;
  if (!prior || !Number.isFinite(Number(prior.bucket))) {
    return { minute: { bucket, lastPrice: price }, close: null };
  }
  if (bucket <= Number(prior.bucket)) {
    return { minute: { bucket: Number(prior.bucket), lastPrice: price }, close: null };
  }
  return {
    minute: { bucket, lastPrice: price },
    close: { bucket: Number(prior.bucket), price: Number(prior.lastPrice) },
  };
}

/** Short balanceado: la secante entre los dos bordes, en unidades del perp. */
function balancedQty({ valueAt, lower, upper, spot, execPrice }) {
  const slope = (valueAt(upper) - valueAt(lower)) / (upper - lower);
  return Math.max(0, slope * (spot / execPrice));
}

/** Fuera de rango: el ETH que queda en el LP, en unidades del perp. */
function outOfRangeQty({ volatileAt, spot, execPrice }) {
  return Math.max(0, volatileAt(spot) * (spot / execPrice));
}

/**
 * Reserva K_E: lo que costaria recentrar el LP en el borde E con el mismo ancho.
 *
 *   neto = bruto - gas - |x_nuevo(neto) - x_anterior| * E * k
 *
 * resuelto por punto fijo. Supone un rango centrado en el propio borde; no
 * reproduce un gap de ejecucion ni otro centro.
 */
function estimateRecenterCostUsd({ edge, valueAtEdge, volatileAtEdge, widthFrac, gasUsd, swapCostRate }) {
  const gross = Math.max(0, finite(valueAtEdge, 0));
  const newLower = edge * (1 - widthFrac / 2);
  const newUpper = edge * (1 + widthFrac / 2);
  const x1 = 1 / Math.sqrt(edge) - 1 / Math.sqrt(newUpper);
  const y1 = Math.sqrt(edge) - Math.sqrt(newLower);
  const v1 = x1 * edge + y1;
  const volatilePerUsd = v1 > 0 ? x1 / v1 : 0;
  const xOld = Math.max(0, finite(volatileAtEdge, 0));
  let net = Math.max(0, gross - gasUsd);
  for (let i = 0; i < RECENTER_ITERATIONS; i += 1) {
    const swapCost = Math.abs(net * volatilePerUsd - xOld) * edge * swapCostRate;
    net = Math.max(0, gross - gasUsd - swapCost);
  }
  return gross - net;
}

/**
 * Busca q' en [0, maxQty] con g(q') = 0, donde
 *
 *   g(q') = R + q'(F - F_E) - |q' - q| F c - q' F_E c
 *
 * g es lineal a trozos con quiebre en q, asi que basta evaluar 0, q y maxQty,
 * buscar cambio de signo y biseccionar. Sin raiz: el punto de menor |g|. Nunca
 * devuelve un long ni algo por encima de maxQty.
 */
function solveTerminalQty({ residualUsd, actualQty, execPrice, edgeExecPrice, costRate, maxQty }) {
  const R = finite(residualUsd, 0);
  const F = finite(execPrice, 0);
  const FE = finite(edgeExecPrice, 0);
  const c = Math.max(0, finite(costRate, 0));
  const qMax = Math.max(0, finite(maxQty, 0));
  const q = Math.min(Math.max(finite(actualQty, 0), 0), qMax);
  const g = (x) => R + x * (F - FE) - Math.abs(x - q) * F * c - x * FE * c;

  const points = [0, q, qMax];
  for (const p of points) {
    const value = g(p);
    if (Math.abs(value) <= SOLVER_TOLERANCE_USD) return { qty: p, residualUsd: value, infeasible: false };
  }
  const segments = [[0, q], [q, qMax]].filter(([lo, hi]) => hi > lo);
  for (const [start, end] of segments) {
    let lo = start;
    let hi = end;
    let gLo = g(lo);
    if (gLo * g(hi) > 0) continue;
    for (let i = 0; i < SOLVER_ITERATIONS; i += 1) {
      const mid = (lo + hi) / 2;
      const gMid = g(mid);
      if (gLo * gMid <= 0) {
        hi = mid;
      } else {
        lo = mid;
        gLo = gMid;
      }
    }
    const root = (lo + hi) / 2;
    return { qty: root, residualUsd: g(root), infeasible: false };
  }
  let best = points[0];
  for (const p of points) {
    if (Math.abs(g(p)) < Math.abs(g(best))) best = p;
  }
  return { qty: best, residualUsd: g(best), infeasible: true };
}

/**
 * Registra en el estado el fill de una intencion.
 *
 * Es la UNICA via por la que el lado y la zona avanzan: el prototipo los movia
 * al decidir aunque la orden se bloqueara, y en produccion eso deja a la
 * politica creyendo que cubre un borde que nunca cubrio. Lo comandado se adopta
 * siempre (venga del tope, de un forzado o de ella misma), igual que el ancla
 * de `range_exit_v1`; el lado solo si el fill es de SU intencion.
 */
function promoteTerminalIntent(state, { intentId, commandedQty, now = Date.now() } = {}) {
  const prior = state && typeof state === 'object' ? state : {};
  const next = { ...prior };
  const commanded = finite(commandedQty);
  if (commanded != null) next.committedTargetQty = Math.max(0, commanded);
  const pending = prior.pendingIntent;
  if (pending && intentId != null && pending.id === intentId) {
    next.side = pending.side;
    next.zone = pending.zone;
    next.pendingIntent = null;
    next.lastAdjustAt = now;
    next.lastAdjustGate = pending.gate;
  }
  return next;
}

/**
 * Decide un tick de `terminal_range_v1`.
 *
 * @param {object}   p
 * @param {Function} p.valueAt        USD del LP vigente a un precio del volatil.
 * @param {Function} p.volatileAt     Cantidad de volatil en el LP a ese precio.
 * @param {number}   p.currentPrice   Spot (S).
 * @param {number}   [p.markPrice]    Mark del perp (M). Por defecto S.
 * @param {number}   [p.execPrice]    Precio de ejecucion estimado (F). Por defecto M.
 * @param {number}   p.rangeLowerPrice
 * @param {number}   p.rangeUpperPrice
 * @param {string}   [p.liquidity]    Liquidez del LP; su cambio desplaza B.
 * @param {number}   p.actualQty      Short vigente.
 * @param {number}   p.hedgeNetUsd    Neto acumulado del hedge (realizado +
 *                                    latente + funding - fees - slippage).
 * @param {object}   p.state          terminalRangePolicyState persistido.
 * @param {number}   p.now
 * @param {boolean}  [p.forceRebalance]
 * @param {object}   [p.config]
 * @param {number}   [p.minOrderNotionalUsd]
 */
function decideTerminalRangeV1({
  valueAt,
  volatileAt,
  currentPrice,
  markPrice,
  execPrice,
  rangeLowerPrice,
  rangeUpperPrice,
  liquidity = null,
  actualQty = 0,
  hedgeNetUsd = 0,
  state = {},
  now = Date.now(),
  forceRebalance = false,
  config = DEFAULT_TERMINAL_CONFIG,
  minOrderNotionalUsd = 11,
} = {}) {
  const cfg = normalizeTerminalConfig(config);
  const S = finite(currentPrice, 0);
  const M = finite(markPrice, S) > 0 ? finite(markPrice, S) : S;
  const F = finite(execPrice, M) > 0 ? finite(execPrice, M) : M;
  const a = finite(rangeLowerPrice, 0);
  const b = finite(rangeUpperPrice, 0);
  const held = Math.max(0, finite(actualQty, 0));
  const hedgeNet = finite(hedgeNetUsd, 0);
  const prior = state && typeof state === 'object' ? state : {};
  const key = rangeKey(a, b);

  const hold = (gate, nextState = prior, extra = {}) => ({
    policyVersion: TERMINAL_RANGE_V1,
    decision: 'hold',
    gate,
    targetQty: held,
    adjustQty: 0,
    intentId: null,
    residualUsd: null,
    infeasible: false,
    edge: null,
    nextState,
    ...extra,
  });

  if (!key || !(S > 0) || typeof valueAt !== 'function' || typeof volatileAt !== 'function') {
    return hold('range_unavailable');
  }

  const zoneNow = resolveZone(S, a, b);
  const { minute, close } = advanceMinute(prior.minute, S, now);
  const widthFrac = (b - a) / ((a + b) / 2);

  // Objetivo para un lado/zona dados, con los precios de ESTE tick. Se usa al
  // decidir, al reintentar y al forzar: la intencion guarda el lado, no la
  // cantidad, para que un reintento no mande un numero rancio.
  const targetFor = (cycle, side, zone) => {
    if (zone !== 'inside') {
      return { qty: outOfRangeQty({ volatileAt, spot: S, execPrice: F }), residualUsd: null, infeasible: false, edge: null };
    }
    if (side === 0) {
      return { qty: balancedQty({ valueAt, lower: a, upper: b, spot: S, execPrice: F }), residualUsd: null, infeasible: false, edge: null };
    }
    const E = side < 0 ? a : b;
    const FE = E * (M / S);
    const VE = valueAt(E);
    const KE = estimateRecenterCostUsd({
      edge: E,
      valueAtEdge: VE,
      volatileAtEdge: volatileAt(E),
      widthFrac,
      gasUsd: cfg.gasUsd,
      swapCostRate: cfg.swapCostRate,
    });
    const N = hedgeNet - finite(cycle.hedgeNetBaselineUsd, 0);
    const R = VE - finite(cycle.baselineValueUsd, 0) + N - KE - held * (F - M);
    const maxQty = (valueAt(finite(cycle.anchorPrice, S)) * cfg.maxHedge) / F;
    const solved = solveTerminalQty({
      residualUsd: R, actualQty: held, execPrice: F, edgeExecPrice: FE, costRate: cfg.hedgeCostRate, maxQty,
    });
    return { qty: solved.qty, residualUsd: solved.residualUsd, infeasible: solved.infeasible, edge: E };
  };

  const rebalance = (gate, cycle, { side, zone, id }) => {
    const target = targetFor(cycle, side, zone);
    const seq = finite(cycle.intentSeq, 0) + (id ? 0 : 1);
    const intentId = id || `${cycle.cycleId}:${seq}`;
    return {
      policyVersion: TERMINAL_RANGE_V1,
      decision: 'rebalance',
      gate,
      targetQty: target.qty,
      adjustQty: target.qty - held,
      intentId,
      residualUsd: target.residualUsd,
      infeasible: target.infeasible,
      edge: target.edge,
      nextState: {
        ...cycle,
        intentSeq: seq,
        candidate: null,
        pendingIntent: { id: intentId, side, zone, gate, targetQty: target.qty, decidedAt: now },
        lastResidualUsd: target.residualUsd,
        lastInfeasible: target.infeasible,
        infeasibleCount: finite(cycle.infeasibleCount, 0) + (target.infeasible ? 1 : 0),
        lastEdge: target.edge,
      },
    };
  };

  // --- Apertura de ciclo: primera vez, o el LP se re-centro ----------------
  if (prior.rangeKey !== key) {
    const anchor = zoneNow === 'inside' ? S : (a + b) / 2;
    const cycle = {
      rangeKey: key,
      cycleId: finite(prior.cycleId, 0) + 1,
      anchorPrice: anchor,
      openedAt: now,
      baselineValueUsd: valueAt(S),
      hedgeNetBaselineUsd: hedgeNet,
      liquidity: liquidity == null ? null : String(liquidity),
      intentSeq: 0,
      committedTargetQty: prior.committedTargetQty ?? null,
      minute,
      candidate: null,
      pendingIntent: null,
      infeasibleCount: 0,
    };
    return rebalance(prior.rangeKey ? 'cycle_rebased' : 'cycle_open', cycle, { side: 0, zone: zoneNow });
  }

  let cycle = { ...prior, minute };

  // --- Cambio de liquidez sin cambio de rango -------------------------------
  // V escala linealmente con L para los mismos ticks, asi que el capital
  // aportado o retirado vale V_nuevo(S) * (1 - L_viejo/L_nuevo). Se suma a B
  // para que un increase no se lea como ganancia del ciclo.
  const priorL = finite(prior.liquidity);
  const nextL = finite(liquidity);
  if (priorL > 0 && nextL > 0 && priorL !== nextL) {
    const capitalDelta = valueAt(S) * (1 - priorL / nextL);
    cycle = {
      ...cycle,
      baselineValueUsd: finite(cycle.baselineValueUsd, 0) + capitalDelta,
      liquidity: String(liquidity),
    };
  } else if (!(priorL > 0) && nextL > 0) {
    cycle = { ...cycle, liquidity: String(liquidity) };
  }

  const pending = cycle.pendingIntent || null;
  const intendedSide = pending ? pending.side : finite(cycle.side, 0);
  const intendedZone = pending ? pending.zone : (cycle.zone || 'inside');

  if (forceRebalance) {
    return rebalance('forced', cycle, { side: intendedSide, zone: zoneNow === 'inside' ? 'inside' : zoneNow });
  }

  // --- Senales: solo en cierres de minuto -----------------------------------
  if (close) {
    const closeZone = resolveZone(close.price, a, b);
    if (closeZone !== intendedZone) {
      // Transicion de zona: sin confirmacion ni offset. La zona se reevalua con
      // el precio de ESTE tick, que es la apertura en la que se ejecuta.
      if (zoneNow !== 'inside') {
        return rebalance('range_exit', { ...cycle, candidate: null }, { side: intendedSide, zone: zoneNow });
      }
      const thresholds = resolveThresholds({
        anchor: finite(cycle.anchorPrice, S), lower: a, upper: b, threshold: cfg.threshold,
      });
      const dir = resolveDirection(S, thresholds);
      return rebalance('range_reentry', { ...cycle, candidate: null }, { side: dir, zone: 'inside' });
    }

    if (closeZone === 'inside') {
      const thresholds = resolveThresholds({
        anchor: finite(cycle.anchorPrice, S), lower: a, upper: b, threshold: cfg.threshold,
      });
      const dir = resolveDirection(close.price, thresholds);
      if (dir !== 0 && dir !== intendedSide) {
        const prev = cycle.candidate;
        const continues = prev && prev.dir === dir && Number(close.bucket) === Number(prev.lastBucket) + 1;
        const candidate = continues
          ? { ...prev, lastBucket: close.bucket }
          : { dir, startBucket: close.bucket, lastBucket: close.bucket };
        if (candidate.lastBucket - candidate.startBucket >= cfg.confirmMinutes) {
          // Una senal interior confirmada no se cancela porque este tick haya
          // vuelto al centro; si abrio fuera, cubre el ETH restante.
          return rebalance(
            zoneNow === 'inside' ? 'terminal_adjust' : 'range_exit',
            { ...cycle, candidate: null },
            { side: dir, zone: zoneNow },
          );
        }
        cycle = { ...cycle, candidate };
        if (!pending) return hold('terminal_confirming', cycle, { thresholds });
      } else {
        cycle = { ...cycle, candidate: null };
      }
    } else {
      cycle = { ...cycle, candidate: null };
    }
  }

  // --- Intencion decidida y aun sin fill: se reemite -------------------------
  if (pending) {
    return rebalance('pending_retry', cycle, { side: pending.side, zone: pending.zone, id: pending.id });
  }

  // --- La orden anterior, ¿aterrizo? ------------------------------------------
  const committed = finite(cycle.committedTargetQty);
  if (committed != null) {
    const gap = Math.abs(held - committed);
    const tolerance = Math.max(committed * COMMIT_TOLERANCE_PCT, RESIDUAL_QTY);
    if (gap > tolerance) {
      const isFullClose = committed <= RESIDUAL_QTY && held > RESIDUAL_QTY;
      if (isFullClose || gap * S >= Math.max(0, finite(minOrderNotionalUsd, 11))) {
        return {
          ...hold('commit_incomplete', cycle),
          decision: 'rebalance',
          targetQty: committed,
          adjustQty: committed - held,
        };
      }
      return hold('commit_below_min_notional', cycle, { commitGapUsd: gap * S });
    }
  }

  if (cycle.candidate) return hold('terminal_confirming', cycle);
  if (intendedZone !== 'inside') return hold('outside_hold', cycle);
  return hold(intendedSide === 0 ? 'balanced_hold' : 'terminal_hold', cycle);
}

module.exports = {
  TERMINAL_RANGE_V1,
  DEFAULT_TERMINAL_CONFIG,
  MINUTE_MS,
  COMMIT_TOLERANCE_PCT,
  normalizeTerminalConfig,
  rangeKey,
  resolveZone,
  resolveThresholds,
  resolveDirection,
  advanceMinute,
  balancedQty,
  outOfRangeQty,
  estimateRecenterCostUsd,
  solveTerminalQty,
  promoteTerminalIntent,
  decideTerminalRangeV1,
};
