/**
 * accounting.js
 *
 * Funciones puras para llevar la contabilidad acumulada del orquestador.
 *
 * El accounting es **acumulado durante toda la vida del orquestador**:
 * cuando se mata un LP y se crea otro, los totales NO se reinician — solo
 * se incrementa el contador `lpCount`.
 *
 * Campos rastreados:
 *   lpFeesUsd              - fees brutas ganadas en LP (acumulado)
 *   gasSpentUsd            - gas pagado en todas las acciones on-chain
 *   swapSlippageUsd        - slippage acumulado en swaps de rebalance/modify
 *   hedgeRealizedPnlUsd    - P&L realizado de hedges cerrados (acumulado)
 *   hedgeUnrealizedPnlUsd  - P&L no realizado del hedge actual (mark-to-market)
 *   hedgeFundingUsd        - funding payments del hedge (signed: + recibido / - pagado)
 *   hedgeExecutionFeesUsd  - taker fees pagadas en el exchange por el hedge (acumulado)
 *   hedgeSlippageUsd       - slippage de las ejecuciones del hedge (acumulado)
 *   priceDriftUsd          - deriva de precio sobre el LP (current vs initial)
 *   totalNetPnlUsd         - sum/diff de todos los anteriores (ver recomputeNetPnl)
 *   lpCount                - número total de LPs creados a lo largo de la vida
 */

const DEFAULT_ACCOUNTING = Object.freeze({
  lpFeesUsd: 0,
  gasSpentUsd: 0,
  swapSlippageUsd: 0,
  hedgeRealizedPnlUsd: 0,
  hedgeUnrealizedPnlUsd: 0,
  hedgeFundingUsd: 0,
  hedgeExecutionFeesUsd: 0,
  hedgeSlippageUsd: 0,
  priceDriftUsd: 0,
  // Acumulado neto de capital agregado / retirado vía
  // increase-liquidity / decrease-liquidity. Positivo = agregado al LP,
  // negativo = retirado a la wallet. NO afecta el netPnl, solo sirve
  // para distinguir movimientos de capital de la deriva de precio en
  // los gráficos / debugging del orquestador.
  capitalAdjustmentsUsd: 0,
  totalNetPnlUsd: 0,
  lpCount: 0,
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAccounting(accounting) {
  const base = accounting || {};
  return {
    lpFeesUsd: num(base.lpFeesUsd),
    gasSpentUsd: num(base.gasSpentUsd),
    swapSlippageUsd: num(base.swapSlippageUsd),
    hedgeRealizedPnlUsd: num(base.hedgeRealizedPnlUsd),
    hedgeUnrealizedPnlUsd: num(base.hedgeUnrealizedPnlUsd),
    hedgeFundingUsd: num(base.hedgeFundingUsd),
    hedgeExecutionFeesUsd: num(base.hedgeExecutionFeesUsd),
    hedgeSlippageUsd: num(base.hedgeSlippageUsd),
    priceDriftUsd: num(base.priceDriftUsd),
    capitalAdjustmentsUsd: num(base.capitalAdjustmentsUsd),
    totalNetPnlUsd: num(base.totalNetPnlUsd),
    lpCount: num(base.lpCount),
  };
}

/**
 * Fórmula del PnL neto del orquestador:
 *
 *   netPnl = lpFees ganadas en el LP
 *          − gas (acciones on-chain del LP)
 *          − swap slippage (rebalanceos/modify-range del LP)
 *          + hedge realized (cycles cerrados del hedge)
 *          + hedge unrealized (mark-to-market del hedge actual)
 *          + funding (signed; positivo si lo recibimos)
 *          − execution fees del hedge (taker fees del exchange)
 *          − slippage del hedge (ejecuciones de rebalanceo)
 *          + price drift del LP (delta de valuación por movimiento de precio)
 */
function recomputeNetPnl(accounting) {
  const a = normalizeAccounting(accounting);
  a.totalNetPnlUsd =
    a.lpFeesUsd
    - a.gasSpentUsd
    - a.swapSlippageUsd
    + a.hedgeRealizedPnlUsd
    + a.hedgeUnrealizedPnlUsd
    + a.hedgeFundingUsd
    - a.hedgeExecutionFeesUsd
    - a.hedgeSlippageUsd
    + a.priceDriftUsd;
  return a;
}

/**
 * Calcula el delta entre dos snapshots del LP. Solo expone el incremento de
 * fees y la deriva de precio. NO calcula gas ni slippage — esos se aplican
 * en `applyTxCostDelta` cuando una acción on-chain se finaliza. El P&L del
 * hedge tiene su propio helper (`applyHedgeStateDelta`).
 *
 * @param {object|null} prevSnapshot - snapshot anterior (o null si es el primero)
 * @param {object} currentSnapshot - snapshot actual
 */
function computeAccountingDelta(prevSnapshot, currentSnapshot) {
  const prevFees = num(prevSnapshot?.unclaimedFeesUsd);
  const currFees = num(currentSnapshot?.unclaimedFeesUsd);
  // Las fees solo crecen mientras la posición no se cobra. Si decrecen
  // (porque hubo collect-fees) tomamos el delta como 0 — el incremento real
  // se aplica en applyTxCostDelta cuando llega el tx_finalized de collect.
  const lpFeesDelta = Math.max(0, currFees - prevFees);

  const prevValue = num(prevSnapshot?.currentValueUsd);
  const currValue = num(currentSnapshot?.currentValueUsd);
  const priceDriftDelta = prevSnapshot ? currValue - prevValue : 0;

  return {
    lpFeesDelta,
    priceDriftDelta,
  };
}

function applyAccountingDelta(currentAccounting, delta) {
  const a = normalizeAccounting(currentAccounting);
  a.lpFeesUsd += num(delta?.lpFeesDelta);
  a.priceDriftUsd += num(delta?.priceDriftDelta);
  return recomputeNetPnl(a);
}

/**
 * Snapshot del estado del hedge tal como lo persiste el motor delta-neutral.
 * Estos campos vienen de `protected_uniswap_pools.strategy_state_json`:
 *
 *   {
 *     fundingAccumUsd:      signed (positivo = recibido, negativo = pagado)
 *     hedgeRealizedPnlUsd:  acumulado de cycles cerrados del hedge
 *     hedgeUnrealizedPnlUsd: mark-to-market del hedge actual
 *     executionFeesUsd:     taker fees acumuladas pagadas al exchange
 *     slippageUsd:          slippage acumulado de las ejecuciones del hedge
 *   }
 */
function readHedgeStateFromProtection(protection) {
  if (!protection) return null;
  const state = protection.strategyState || protection.strategy_state_json || null;
  if (!state || typeof state !== 'object') return null;
  return {
    fundingAccumUsd: num(state.fundingAccumUsd),
    hedgeRealizedPnlUsd: num(state.hedgeRealizedPnlUsd),
    hedgeUnrealizedPnlUsd: num(state.hedgeUnrealizedPnlUsd),
    executionFeesUsd: num(state.executionFeesUsd),
    slippageUsd: num(state.slippageUsd),
  };
}

/**
 * Aplica el delta de los costos / P&L del hedge a la contabilidad del
 * orquestador. Para acumuladores (funding, realized, execFees, slippage)
 * computa la diferencia contra el `prevHedgeState`. Para el unrealized
 * (mark-to-market) usa asignación ABSOLUTA porque no es un acumulador.
 *
 * Si `prevHedgeState` es null, asume que estamos en el primer tick de un
 * hedge nuevo y NO aplica delta a los acumuladores (toma el snapshot como
 * baseline). Esto evita doble conteo después de un kill+recreate del LP.
 *
 * @param {object} currentAccounting
 * @param {object|null} prevHedgeState - estado del hedge en el tick anterior
 * @param {object|null} currentHedgeState - estado actual del hedge
 * @returns {{ accounting: object, hedgeBaseline: object|null }}
 */
function applyHedgeStateDelta(currentAccounting, prevHedgeState, currentHedgeState) {
  const a = normalizeAccounting(currentAccounting);

  if (!currentHedgeState) {
    // Sin hedge activo: el unrealized se queda en 0 (mark-to-market del hedge cerrado).
    a.hedgeUnrealizedPnlUsd = 0;
    return { accounting: recomputeNetPnl(a), hedgeBaseline: null };
  }

  // Mark-to-market: siempre asignación absoluta.
  a.hedgeUnrealizedPnlUsd = num(currentHedgeState.hedgeUnrealizedPnlUsd);

  if (prevHedgeState) {
    a.hedgeFundingUsd       += num(currentHedgeState.fundingAccumUsd)     - num(prevHedgeState.fundingAccumUsd);
    a.hedgeRealizedPnlUsd   += num(currentHedgeState.hedgeRealizedPnlUsd) - num(prevHedgeState.hedgeRealizedPnlUsd);
    a.hedgeExecutionFeesUsd += num(currentHedgeState.executionFeesUsd)    - num(prevHedgeState.executionFeesUsd);
    a.hedgeSlippageUsd      += num(currentHedgeState.slippageUsd)         - num(prevHedgeState.slippageUsd);
  }
  // Si prevHedgeState es null, NO acumulamos nada todavía: el current pasa a
  // ser el baseline para los siguientes ticks.

  return { accounting: recomputeNetPnl(a), hedgeBaseline: currentHedgeState };
}

/**
 * Aplica costos de una transacción confirmada (gas + slippage). Para
 * `collect-fees` y `reinvest-fees`, también permite registrar las fees
 * realmente cobradas (collectedFeesUsd). Para `increase-liquidity` /
 * `decrease-liquidity`, `capitalDeltaUsd` registra el capital agregado
 * (positivo) o retirado (negativo) — NO afecta el netPnl, solo se acumula
 * para que el dashboard pueda distinguir movimientos de capital de la
 * deriva de precio del LP.
 */
function applyTxCostDelta(currentAccounting, {
  gasCostUsd = 0,
  slippageCostUsd = 0,
  collectedFeesUsd = 0,
  capitalDeltaUsd = 0,
} = {}) {
  const a = normalizeAccounting(currentAccounting);
  a.gasSpentUsd += num(gasCostUsd);
  a.swapSlippageUsd += num(slippageCostUsd);
  // collectedFeesUsd se agrega al total de LP fees ganadas (independientemente
  // de si se reinvierten o no).
  a.lpFeesUsd += num(collectedFeesUsd);
  a.capitalAdjustmentsUsd += num(capitalDeltaUsd);
  return recomputeNetPnl(a);
}

function incrementLpCount(currentAccounting, by = 1) {
  const a = normalizeAccounting(currentAccounting);
  a.lpCount += num(by);
  return recomputeNetPnl(a);
}

module.exports = {
  DEFAULT_ACCOUNTING,
  normalizeAccounting,
  recomputeNetPnl,
  computeAccountingDelta,
  applyAccountingDelta,
  applyTxCostDelta,
  incrementLpCount,
  applyHedgeStateDelta,
  readHedgeStateFromProtection,
};
