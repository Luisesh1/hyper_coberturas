import { formatRelativeTimestamp, formatUsd } from '../../UniswapPools/utils/pool-formatters';

const PHASE_LABELS = {
  idle: 'Sin LP activo',
  lp_active: 'En zona central',
  evaluating: 'Evaluando',
  needs_rebalance: 'Rebalanceo recomendado',
  urgent_adjust: 'Ajuste urgente',
  executing: 'Ejecutando',
  verifying: 'Verificando',
  failed: 'Error - revision humana',
  complete: 'Completado',
};

function humanizeReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return null;
  const normalized = text.toLowerCase();

  if (normalized.startsWith('verification_failed')) {
    return 'La verificacion on-chain no coincide con el estado esperado del orquestador.';
  }
  if (normalized === 'position_not_found') {
    return 'No se encontro la posicion LP activa en el escaneo on-chain.';
  }
  if (normalized === 'scan_failed') {
    return 'Fallo el escaneo on-chain usado para reconciliar el LP.';
  }
  if (normalized === 'insufficient_margin') {
    return 'La proteccion asociada no pudo actuar por margen insuficiente.';
  }
  if (normalized.includes('cooldown')) {
    return 'El orquestador sigue en cooldown antes de poder reintentarlo.';
  }
  return text;
}

function buildCommonDetails(orchestrator) {
  const details = [];
  if (orchestrator.phase) {
    details.push({
      label: 'Fase',
      value: PHASE_LABELS[orchestrator.phase] || orchestrator.phase,
    });
  }
  if (orchestrator.lastDecision) {
    details.push({ label: 'Ultima decision', value: orchestrator.lastDecision });
  }
  if (orchestrator.lastEvaluationAt) {
    details.push({
      label: 'Ultima evaluacion',
      value: formatRelativeTimestamp(orchestrator.lastEvaluationAt),
    });
  }
  return details;
}

export function getOrchestratorIssue(orchestrator, now = Date.now()) {
  if (!orchestrator) return null;

  const commonDetails = buildCommonDetails(orchestrator);
  const evaluation = orchestrator.lastEvaluation?.evaluation || null;
  const costEstimate = orchestrator.lastEvaluation?.costEstimate || null;
  const netEarnings = Number(orchestrator.lastEvaluation?.netEarnings);

  if (orchestrator.phase === 'failed') {
    return {
      kind: 'failed',
      tone: 'urgent',
      icon: '!',
      chipLabel: 'Error critico',
      title: 'Orquestador detenido por error',
      summary: humanizeReason(orchestrator.lastError)
        || 'La ultima verificacion dejo al orquestador en estado failed y requiere intervencion.',
      details: [
        ...commonDetails,
        orchestrator.lastError ? { label: 'Detalle tecnico', value: orchestrator.lastError } : null,
      ].filter(Boolean),
      resolveLabel: 'Reconciliar y reevaluar',
    };
  }

  if (orchestrator.nextEligibleAttemptAt && Number(orchestrator.nextEligibleAttemptAt) > now) {
    return {
      kind: 'cooldown',
      tone: 'warn',
      icon: '!',
      chipLabel: 'Cooldown',
      title: 'Orquestador en espera',
      summary: humanizeReason(orchestrator.cooldownReason)
        || 'El orquestador detecto un bloqueo temporal y esta esperando antes de reintentar.',
      details: [
        ...commonDetails,
        orchestrator.cooldownReason ? { label: 'Motivo', value: orchestrator.cooldownReason } : null,
        { label: 'Proximo intento', value: formatRelativeTimestamp(orchestrator.nextEligibleAttemptAt) },
      ].filter(Boolean),
      resolveLabel: 'Forzar reevaluacion',
    };
  }

  if (orchestrator.phase === 'urgent_adjust') {
    return {
      kind: 'urgent_adjust',
      tone: 'urgent',
      icon: '!',
      chipLabel: 'Fuera de rango',
      title: 'Ajuste urgente recomendado',
      summary: evaluation?.outOfRangeSide === 'below'
        ? 'El precio actual cayo por debajo del rango del LP.'
        : 'El precio actual subio por encima del rango del LP.',
      details: [
        ...commonDetails,
        evaluation?.outOfRangeSide ? { label: 'Lado', value: evaluation.outOfRangeSide } : null,
      ].filter(Boolean),
      resolveLabel: 'Reconciliar y reevaluar',
    };
  }

  if (orchestrator.phase === 'needs_rebalance') {
    return {
      kind: 'needs_rebalance',
      tone: 'warn',
      icon: '!',
      chipLabel: 'Rebalanceo',
      title: 'Rebalanceo recomendado',
      summary: Number.isFinite(netEarnings) && costEstimate?.totalCostUsd != null
        ? `El coste estimado ${formatUsd(costEstimate.totalCostUsd)} sigue siendo razonable frente a las ganancias netas ${formatUsd(netEarnings)}.`
        : 'El orquestador detecto que conviene recentrar o ajustar el LP.',
      details: commonDetails,
      resolveLabel: 'Reevaluar ahora',
    };
  }

  if (orchestrator.lastError) {
    return {
      kind: 'warning',
      tone: 'warn',
      icon: '!',
      chipLabel: 'Incidencia',
      title: 'Incidencia detectada',
      summary: humanizeReason(orchestrator.lastError),
      details: [
        ...commonDetails,
        { label: 'Detalle tecnico', value: orchestrator.lastError },
      ],
      resolveLabel: 'Reconciliar y reevaluar',
    };
  }

  return null;
}
