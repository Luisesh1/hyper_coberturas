/**
 * segments.js
 *
 * Matemática pura de los "tramos" del orquestador LP: cada tramo es la vida
 * de un LP (un rango) dentro del orquestador. Sin DB ni servicios: lo
 * consumen el corte de tramos y las consultas de resumen.
 */

const { normalizeAccounting, recomputeNetPnl } = require('./accounting');
const { buildLpValuation } = require('../protected-pool-delta-neutral/terminal-range');
const { resolveDeltaNeutralOrientation } = require('../delta-neutral-math.service');

// Acciones que cierran el LP viejo y abren uno nuevo (o cambian su capital).
const SEGMENT_OPENING_ACTIONS = new Set([
  'modify-range',
  'rebalance',
  'increase-liquidity',
  'decrease-liquidity',
  'reinvest-fees',
]);

// Acciones que solo cierran: no queda LP al que abrir tramo.
const SEGMENT_CLOSING_ACTIONS = new Set(['close-to-usdc', 'close-keep-assets']);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Tramo = acumulado − baseline, campo a campo (incluidas las políticas
 * sombra). El neto se recalcula en vez de restarse. Sin baseline, el
 * acumulado normalizado es el tramo.
 */
function subtractAccounting(current, baseline) {
  const cur = normalizeAccounting(current);
  if (!baseline) return cur;
  const base = normalizeAccounting(baseline);

  const out = {};
  for (const key of Object.keys(cur)) {
    if (key === 'shadowPolicies') continue;
    out[key] = cur[key] - base[key];
  }

  const policies = {};
  const versions = new Set([...Object.keys(cur.shadowPolicies), ...Object.keys(base.shadowPolicies)]);
  for (const version of versions) {
    const c = cur.shadowPolicies[version] || {};
    const b = base.shadowPolicies[version] || {};
    const diff = {};
    for (const field of ['realizedPnlUsd', 'unrealizedPnlUsd', 'fundingUsd', 'executionFeesUsd', 'slippageUsd']) {
      diff[field] = num(c[field]) - num(b[field]);
    }
    // netPnlUsd lo recalcula normalizeShadowPolicyAccounting dentro de recomputeNetPnl.
    policies[version] = diff;
  }
  out.shadowPolicies = policies;

  return recomputeNetPnl(out);
}

/**
 * Índice (0/1) del token volátil del pool. Acepta un snapshot (`token0.symbol`)
 * o un objeto con `token0Symbol`/`token1Symbol` (el orquestador). Sin
 * orientación resoluble se asume token0 volátil (precio crudo = precio USD).
 */
function resolveVolatileTokenIndex(source) {
  if (!source || typeof source !== 'object') return 0;
  const orientation = resolveDeltaNeutralOrientation(source);
  return orientation?.eligible && orientation.volatileTokenIndex === 1 ? 1 : 0;
}

/**
 * Precio crudo del pool (token1 por token0, el espacio de `priceCurrent` y de
 * `rangeLower/UpperPrice`) -> precio USD del volátil. null si no es usable.
 */
function toVolatileUsd(rawPrice, volatileTokenIndex) {
  if (rawPrice == null) return null;
  const p = Number(rawPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  return volatileTokenIndex === 1 ? 1 / p : p;
}

/**
 * Motivo por el que se cortó el tramo. El lado del precio solo importa en
 * las acciones que re-centran el rango. `price` y los límites van en el
 * espacio crudo del snapshot (token1 por token0); con el estable en token0
 * (`volatileTokenIndex: 1`) se invierten, de modo que «below»/«above» siempre
 * se refieren al precio USD del volátil.
 */
function classifyCloseReason({
  action, price, rangeLowerPrice, rangeUpperPrice, volatileTokenIndex = 0,
} = {}) {
  if (action === 'modify-range' || action === 'rebalance') {
    const p = toVolatileUsd(price, volatileTokenIndex);
    const a = toVolatileUsd(rangeLowerPrice, volatileTokenIndex);
    const b = toVolatileUsd(rangeUpperPrice, volatileTokenIndex);
    const lower = a != null && b != null ? Math.min(a, b) : a;
    const upper = a != null && b != null ? Math.max(a, b) : b;
    if (p != null && lower != null && p < lower) return 'range_exit_below';
    if (p != null && upper != null && p > upper) return 'range_exit_above';
    return 'manual_rerange';
  }
  if (action === 'increase-liquidity' || action === 'decrease-liquidity' || action === 'reinvest-fees') {
    return 'capital_change';
  }
  if (SEGMENT_CLOSING_ACTIONS.has(action)) return 'lp_closed';
  return 'unknown';
}

/**
 * Deriva del LP viejo entre su última foto y el precio del finalize (lo que
 * tardó la firma): `V(pFinal) − V(pLast)` con la misma liquidez y sin fees
 * pendientes (esas ya se devengaron tick a tick como `lpFeesUsd`). Ambos
 * precios llegan crudos (token1 por token0) y se pasan al precio USD del
 * volátil antes de valorar. 0 si no se puede valorar.
 */
function estimateSigningDriftUsd(lastSnapshot, finalizePrice) {
  // Sin valor de partida no hay contra qué cuadrar el cierre del tramo.
  const rawValue = lastSnapshot?.currentValueUsd;
  if (rawValue == null || !Number.isFinite(Number(rawValue))) return 0;
  const orientation = resolveDeltaNeutralOrientation(lastSnapshot);
  if (!orientation?.eligible) return 0;
  const volatileIndex = orientation.volatileTokenIndex === 1 ? 1 : 0;
  const pLast = toVolatileUsd(lastSnapshot.priceCurrent, volatileIndex);
  const pFinal = toVolatileUsd(finalizePrice, volatileIndex);
  if (pLast == null || pFinal == null) return 0;
  const valuation = buildLpValuation({ ...lastSnapshot, unclaimedFees0: 0, unclaimedFees1: 0 });
  if (!valuation) return 0;
  const drift = valuation.valueAt(pFinal) - valuation.valueAt(pLast);
  return Number.isFinite(drift) ? drift : 0;
}

/**
 * Resumen de la cobertura durante un tramo. Cada fila rige desde su
 * `createdAt` hasta la siguiente (o hasta el cierre / `now`), recortada al
 * intervalo del tramo; `avgPct` pondera por ese tiempo vigente.
 */
function summarizeCoverage(rebalances, { openedAt, closedAt, now } = {}) {
  const rows = (Array.isArray(rebalances) ? rebalances : [])
    .map((r) => ({
      at: Number(r.createdAt),
      qty: num(r.actualQtyAfter),
      target: num(r.targetQtyAfter),
    }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);

  if (!rows.length) {
    return { adjustments: 0, openQty: null, lastQty: null, minPct: null, maxPct: null, avgPct: null };
  }

  const start = Number.isFinite(Number(openedAt)) ? Number(openedAt) : rows[0].at;
  const endRaw = closedAt != null ? Number(closedAt) : Number(now ?? Date.now());
  const end = Number.isFinite(endRaw) ? endRaw : rows[rows.length - 1].at;

  const pctOf = (r) => (r.target > 0 ? (r.qty / r.target) * 100 : null);

  let minPct = null;
  let maxPct = null;
  let weighted = 0;
  let weight = 0;
  rows.forEach((r, i) => {
    const pct = pctOf(r);
    if (pct == null) return;
    minPct = minPct == null ? pct : Math.min(minPct, pct);
    maxPct = maxPct == null ? pct : Math.max(maxPct, pct);
    const from = Math.max(r.at, start);
    const to = Math.min(i + 1 < rows.length ? rows[i + 1].at : end, end);
    const span = to - from;
    if (span > 0) {
      weighted += pct * span;
      weight += span;
    }
  });

  return {
    adjustments: rows.length,
    openQty: rows[0].qty,
    lastQty: rows[rows.length - 1].qty,
    minPct,
    maxPct,
    avgPct: weight > 0 ? weighted / weight : (minPct == null ? null : minPct),
  };
}

module.exports = {
  SEGMENT_OPENING_ACTIONS,
  SEGMENT_CLOSING_ACTIONS,
  subtractAccounting,
  classifyCloseReason,
  estimateSigningDriftUsd,
  resolveVolatileTokenIndex,
  summarizeCoverage,
};
