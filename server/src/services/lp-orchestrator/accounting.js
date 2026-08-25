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
 *
 * `shadowPolicies` contiene el mismo desglose para cada cobertura
 * **contrafactual** que el motor delta-neutral simula en paralelo. Se acumula
 * igual que la real —sobrevive al kill+recreate del LP— pero queda FUERA de
 * `totalNetPnlUsd`: es plata que nunca se movió.
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
  // Cobertura sombra: contrafactual acumulado de `net_profit_v1`. Mismo
  // desglose que la pata real para poder compararlas fila contra fila.
  shadowRealizedPnlUsd: 0,
  shadowUnrealizedPnlUsd: 0,
  shadowFundingUsd: 0,
  shadowExecutionFeesUsd: 0,
  shadowSlippageUsd: 0,
  // Derivado (ver recomputeNetPnl); no se suma al neto total.
  shadowNetPnlUsd: 0,
  // Desglose contrafactual por policyVersion. Los campos shadow* planos se
  // conservan únicamente para leer series históricas previas a la comparativa.
  shadowPolicies: Object.freeze({}),
  totalNetPnlUsd: 0,
  lpCount: 0,
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeShadowPolicyAccounting(accounting) {
  const base = accounting || {};
  const normalized = {
    realizedPnlUsd: num(base.realizedPnlUsd),
    unrealizedPnlUsd: num(base.unrealizedPnlUsd),
    fundingUsd: num(base.fundingUsd),
    executionFeesUsd: num(base.executionFeesUsd),
    slippageUsd: num(base.slippageUsd),
    netPnlUsd: num(base.netPnlUsd),
  };
  normalized.netPnlUsd = normalized.realizedPnlUsd
    + normalized.unrealizedPnlUsd
    + normalized.fundingUsd
    - normalized.executionFeesUsd
    - normalized.slippageUsd;
  return normalized;
}

function normalizeShadowPolicies(shadowPolicies) {
  if (!shadowPolicies || typeof shadowPolicies !== 'object' || Array.isArray(shadowPolicies)) return {};
  return Object.fromEntries(
    Object.entries(shadowPolicies)
      .filter(([policyVersion, state]) => policyVersion && state && typeof state === 'object' && !Array.isArray(state))
      .map(([policyVersion, state]) => [policyVersion, normalizeShadowPolicyAccounting(state)]),
  );
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
    shadowRealizedPnlUsd: num(base.shadowRealizedPnlUsd),
    shadowUnrealizedPnlUsd: num(base.shadowUnrealizedPnlUsd),
    shadowFundingUsd: num(base.shadowFundingUsd),
    shadowExecutionFeesUsd: num(base.shadowExecutionFeesUsd),
    shadowSlippageUsd: num(base.shadowSlippageUsd),
    shadowNetPnlUsd: num(base.shadowNetPnlUsd),
    shadowPolicies: normalizeShadowPolicies(base.shadowPolicies),
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
 *
 * Aparte se recalcula `shadowNetPnlUsd`, el neto de la pata contrafactual
 * con la misma convención que la de cobertura (realizado + latente + funding
 * − comisiones − slippage). NO entra en `totalNetPnlUsd`: sumarlo mezclaría
 * plata real con una simulación.
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
  a.shadowNetPnlUsd =
    a.shadowRealizedPnlUsd
    + a.shadowUnrealizedPnlUsd
    + a.shadowFundingUsd
    - a.shadowExecutionFeesUsd
    - a.shadowSlippageUsd;
  a.shadowPolicies = normalizeShadowPolicies(a.shadowPolicies);
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
  // Si el LP cambió de identidad (modify-range / rebalance que cierra y reabre
  // la posición), el "delta de valor" entre el LP viejo y el nuevo NO es
  // deriva de precio: es un ajuste de capital ya contabilizado en
  // applyTxCostDelta (gas + slippage + collected fees + capitalDeltaUsd).
  // Tomar el delta aquí causaría doble conteo. La nueva posición arranca con
  // su propia baseline de drift en el siguiente tick.
  const prevIdent = prevSnapshot?.identifier != null ? String(prevSnapshot.identifier) : null;
  const currIdent = currentSnapshot?.identifier != null ? String(currentSnapshot.identifier) : null;
  const positionChanged = prevIdent != null && currIdent != null && prevIdent !== currIdent;
  const priceDriftDelta = (prevSnapshot && !positionChanged) ? currValue - prevValue : 0;

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
 * Snapshot de la cobertura **sombra**, tal como lo persiste el motor
 * delta-neutral en `protected_uniswap_pools.strategy_state_json.shadowSnapshot`
 * (ver `simulateShadowFill` en net-profit-policy.service.js):
 *
 *   {
 *     realizedPnlUsd:    acumulado de recompras simuladas del short
 *     unrealizedPnlUsd:  mark-to-market del short simulado
 *     fundingUsd:        signed (positivo = recibido, negativo = pagado)
 *     executionFeesUsd:  taker fees que habría pagado
 *     slippageUsd:       slippage contra el mid del BBO del momento
 *   }
 *
 * Devuelve `null` cuando la política sombra no está corriendo para esa
 * protección: sin snapshot no hay contrafactual que contabilizar, y el panel
 * usa ese null para no mostrar la sección.
 */
function readShadowStateFromProtection(protection) {
  if (!protection) return null;
  const state = protection.strategyState || protection.strategy_state_json || null;
  if (!state || typeof state !== 'object') return null;
  // El motor pasó de un `shadowSnapshot` singular a `shadowSnapshots` indexado
  // por política. Mientras esta columna siga siendo UNA sola, se lee la de la
  // política declarada en la protección, que es exactamente la que alimentaba
  // el singular. Sin esto la pata contrafactual se sobreescribiría con 0 en
  // base —un cero donde debe haber hueco— y el baseline se perdería, tirando
  // en silencio todo lo acumulado. El desglose por política llega con la
  // contabilidad multi-política.
  // La política declarada se resuelve igual que en el motor
  // (`activeProtection.policyVersion || strategyState.policyVersion`). Mirar
  // sólo el estado dejaría fuera a las filas cuyo `policy_version` vive
  // únicamente en la columna de base: el motor escribiría en
  // `shadowSnapshots[net_profit_v1]` y aquí se buscaría
  // `shadowSnapshots[undefined]`, devolviendo el cero silencioso otra vez.
  const declaredPolicy = protection.policyVersion || state.policyVersion;
  const shadow = state.shadowSnapshot
    || state.shadowSnapshots?.[declaredPolicy]
    || null;
  if (!shadow || typeof shadow !== 'object') return null;
  return {
    realizedPnlUsd: num(shadow.realizedPnlUsd),
    unrealizedPnlUsd: num(shadow.unrealizedPnlUsd),
    fundingUsd: num(shadow.fundingUsd),
    executionFeesUsd: num(shadow.executionFeesUsd),
    slippageUsd: num(shadow.slippageUsd),
  };
}

/**
 * Lee todos los snapshots contrafactuales producidos por el motor. La clave
 * es la policyVersion y no la política viva: en un mismo tick hay dos
 * políticas sombra comparables de forma independiente.
 */
function readShadowStatesFromProtection(protection) {
  if (!protection) return {};
  const state = protection.strategyState || protection.strategy_state_json || null;
  if (!state || typeof state !== 'object') return {};

  const snapshots = state.shadowSnapshots && typeof state.shadowSnapshots === 'object'
    ? state.shadowSnapshots
    : null;
  if (snapshots) {
    return Object.fromEntries(
      Object.entries(snapshots)
        .filter(([policyVersion, shadow]) => policyVersion && shadow && typeof shadow === 'object')
        .map(([policyVersion, shadow]) => [policyVersion, {
          realizedPnlUsd: num(shadow.realizedPnlUsd),
          unrealizedPnlUsd: num(shadow.unrealizedPnlUsd),
          fundingUsd: num(shadow.fundingUsd),
          executionFeesUsd: num(shadow.executionFeesUsd),
          slippageUsd: num(shadow.slippageUsd),
        }]),
    );
  }

  // Migración de snapshots escritos antes de la comparativa multi-política.
  const singular = readShadowStateFromProtection(protection);
  if (!singular) return {};
  const policyVersion = protection.policyVersion || state.policyVersion || 'legacy_zones_v1';
  return { [policyVersion]: singular };
}

/**
 * Espejo de `applyHedgeStateDelta` para la pata sombra: acumuladores por
 * diferencia contra el baseline, latente por asignación absoluta, y sin
 * baseline no se acumula nada (el snapshot actual pasa a ser el inicio).
 *
 * El baseline propio importa: el snapshot de sombra vive atado a la
 * protección, así que al matar y recrear el LP vuelve a cero. Acumular por
 * delta es lo que hace que el contrafactual del orquestador abarque toda su
 * vida, igual que la pata real, y que las dos columnas sean comparables.
 *
 * @param {object} currentAccounting
 * @param {object|null} prevShadowState - snapshot de sombra del tick anterior
 * @param {object|null} currentShadowState - snapshot de sombra actual
 * @returns {{ accounting: object, shadowBaseline: object|null }}
 */
function applyShadowStateDelta(currentAccounting, prevShadowState, currentShadowState) {
  const a = normalizeAccounting(currentAccounting);

  if (!currentShadowState) {
    // Sin sombra activa: el latente del short simulado deja de existir.
    a.shadowUnrealizedPnlUsd = 0;
    return { accounting: recomputeNetPnl(a), shadowBaseline: null };
  }

  a.shadowUnrealizedPnlUsd = num(currentShadowState.unrealizedPnlUsd);

  if (prevShadowState) {
    a.shadowRealizedPnlUsd    += num(currentShadowState.realizedPnlUsd)    - num(prevShadowState.realizedPnlUsd);
    a.shadowFundingUsd        += num(currentShadowState.fundingUsd)        - num(prevShadowState.fundingUsd);
    a.shadowExecutionFeesUsd  += num(currentShadowState.executionFeesUsd)  - num(prevShadowState.executionFeesUsd);
    a.shadowSlippageUsd       += num(currentShadowState.slippageUsd)       - num(prevShadowState.slippageUsd);
  }

  return { accounting: recomputeNetPnl(a), shadowBaseline: currentShadowState };
}

/**
 * Variante multi-política de applyShadowStateDelta. Cada política mantiene
 * su propio baseline para que un kill+recreate no mezcle sus acumuladores ni
 * duplique los resultados del primer snapshot del LP nuevo.
 */
function applyShadowStatesDelta(currentAccounting, prevShadowStates, currentShadowStates) {
  const a = normalizeAccounting(currentAccounting);
  const previous = prevShadowStates && typeof prevShadowStates === 'object' ? prevShadowStates : {};
  const current = currentShadowStates && typeof currentShadowStates === 'object' ? currentShadowStates : {};
  const policyVersions = new Set([
    ...Object.keys(a.shadowPolicies),
    ...Object.keys(previous),
    ...Object.keys(current),
  ]);
  const shadowBaselines = {};

  for (const policyVersion of policyVersions) {
    const existing = normalizeShadowPolicyAccounting(a.shadowPolicies[policyVersion]);
    const snapshot = current[policyVersion];
    if (!snapshot || typeof snapshot !== 'object') {
      existing.unrealizedPnlUsd = 0;
      existing.netPnlUsd = existing.realizedPnlUsd
        + existing.fundingUsd
        - existing.executionFeesUsd
        - existing.slippageUsd;
      a.shadowPolicies[policyVersion] = existing;
      continue;
    }

    const normalizedSnapshot = {
      realizedPnlUsd: num(snapshot.realizedPnlUsd),
      unrealizedPnlUsd: num(snapshot.unrealizedPnlUsd),
      fundingUsd: num(snapshot.fundingUsd),
      executionFeesUsd: num(snapshot.executionFeesUsd),
      slippageUsd: num(snapshot.slippageUsd),
    };
    const baseline = previous[policyVersion];
    existing.unrealizedPnlUsd = normalizedSnapshot.unrealizedPnlUsd;
    if (baseline && typeof baseline === 'object') {
      existing.realizedPnlUsd += normalizedSnapshot.realizedPnlUsd - num(baseline.realizedPnlUsd);
      existing.fundingUsd += normalizedSnapshot.fundingUsd - num(baseline.fundingUsd);
      existing.executionFeesUsd += normalizedSnapshot.executionFeesUsd - num(baseline.executionFeesUsd);
      existing.slippageUsd += normalizedSnapshot.slippageUsd - num(baseline.slippageUsd);
    }
    a.shadowPolicies[policyVersion] = normalizeShadowPolicyAccounting(existing);
    shadowBaselines[policyVersion] = normalizedSnapshot;
  }

  return { accounting: recomputeNetPnl(a), shadowBaselines };
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
  applyShadowStateDelta,
  readShadowStateFromProtection,
  applyShadowStatesDelta,
  readShadowStatesFromProtection,
};
