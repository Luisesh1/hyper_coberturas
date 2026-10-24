/**
 * segment-reset.js
 *
 * Al abrir un tramo (re-range, cambio de liquidez) el LP es otro: los
 * cooldowns, latches y presupuestos diarios de las politicas pertenecian al
 * LP anterior y no deben condicionar la primera decision sobre el nuevo.
 * Solo reescribe estado; nunca opera.
 */

// Estado de decision: se borra al abrir tramo.
const DECISION_STATE_KEYS = Object.freeze([
  'rangeExitPolicyState',
  'rangeExitPolicyGate',
  'terminalRangePolicyState',
  'terminalRangePolicyGate',
  'netProfitPolicyState',
  'netProfitPolicyGate',
  'pendingRotationBudgetIncrement',
  'minDwellUntil',
  'zoneState',
  'lastObservedBoundarySide',
  'lastSnapshotPrice',
  'lastRebalanceAt',
  'nakedExposureSince',
  'nakedExposureTier',
  'nakedExposureByDesign',
  'positionMissingSince',
  'positionMissingConsecutiveCount',
  'truthPending',
  'lastSyntheticInRange',
  'nextEligibleAttemptAt',
  'cooldownReason',
]);

// Estado que sobrevive al corte: acumuladores, telemetria y configuracion.
// Una clave nueva que escriba `evaluate.js` debe caer en una de las dos listas.
const KEPT_STATE_KEYS = Object.freeze([
  'status',
  'lastDeltaQty',
  'lastGamma',
  'lastTargetQty',
  'lastShadowTargetQty',
  'lastActualQty',
  'monitorHeartbeatAt',
  'coverageRatioPct',
  'effectiveBandPct',
  'rv4hPct',
  'rv24hPct',
  'fundingAccumUsd',
  'fundingAllTimeBaselineUsd',
  'hedgeUnrealizedPnlUsd',
  'hedgeRealizedPnlUsd',
  'executionFeesUsd',
  'slippageUsd',
  'lastReconciledFillsAt',
  'lpPnlUsd',
  'distanceToLiqPct',
  'marginModeVerified',
  'lastPositionReadAt',
  'lastPositionReadSource',
  'topUpMaxCount24h',
  'topUpCapUsd',
  'trackingMode',
  'truthAgeMs',
  'lastTruthAt',
  'lastTruthPrice',
  'lastModelAt',
  'lastModelPrice',
  'modelConfidence',
  'basisSpreadBps',
  'consecutiveTruthFailures',
  'consecutiveInspectFailures',
  'lastTrackedMidPrice',
  'lastBboSpreadBps',
  'rpcBudgetState',
  'netProtectionPnlUsd',
  'lastError',
  'decisionOwner',
  'lastDecision',
  'lastDecisionReason',
  'lastMissingDetectedAt',
  'lastShadowSnapshotAt',
  'lastSpotFailureAt',
  'lastSpotFailureReason',
  'nakedNotionalCapUsd',
  'nakedNotionalUsd',
  'netProfitPolicyTargetQty',
  'pendingForceReason',
  'shadowSnapshots',
  'terminalRangeInfeasible',
  'terminalRangeResidualUsd',
  'terminalRangeTargetQty',
  'trackingErrorQty',
  'trackingErrorUsd',
  'policyVersion',
  'executionIntent',
  'terminalRangeConfig',
]);

const SEGMENT_FORCE_REASON = 'segment_opened';

function resetDecisionStateForNewSegment(strategyState) {
  const next = { ...(strategyState || {}) };
  for (const key of DECISION_STATE_KEYS) delete next[key];

  if (next.shadowSnapshots && typeof next.shadowSnapshots === 'object') {
    const snapshots = {};
    for (const [policy, snapshot] of Object.entries(next.shadowSnapshots)) {
      snapshots[policy] = { ...(snapshot || {}), shadowPolicyState: {} };
    }
    next.shadowSnapshots = snapshots;
  }

  next.pendingForceReason = SEGMENT_FORCE_REASON;
  return next;
}

module.exports = {
  DECISION_STATE_KEYS,
  KEPT_STATE_KEYS,
  SEGMENT_FORCE_REASON,
  resetDecisionStateForNewSegment,
};
