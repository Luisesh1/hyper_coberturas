import { fmtSignedUsd } from './format';

export const POLICY_OPTIONS = [
  { value: 'live', label: 'Política viva (real)' },
  { value: 'legacy_zones_v1', label: 'Zonas legacy v1' },
  { value: 'net_profit_v1', label: 'Net profit v1' },
  { value: 'net_profit_v2', label: 'Net profit v2' },
  // Ya se puede elegir al crear una proteccion, pero aqui sigue apareciendo
  // como serie porque tambien corre en sombra en las que no la eligieron: para
  // eso existe la comparativa. Los snapshots anteriores a su alta no la traen,
  // y `selectPolicySnapshot` ya los descarta por `hlAccountUsd` no finito, asi
  // que la serie arranca el dia que se desplego.
  { value: 'range_exit_v1', label: 'Borde de rango v1' },
];

// Componentes del PnL neto, en el mismo orden y con el mismo signo con que
// `server/src/services/lp-orchestrator/accounting.js` los suma en
// recomputeNetPnl(). `sign` es la contribucion al total (los costos restan).
export const LP_PNL_COMPONENTS = [
  { key: 'lpFeesUsd', label: 'Fees LP', sign: 1 },
  { key: 'priceDriftUsd', label: 'Deriva de precio LP', sign: 1 },
  { key: 'gasSpentUsd', label: 'Gas', sign: -1 },
  { key: 'swapSlippageUsd', label: 'Slippage swaps', sign: -1 },
];
export const HEDGE_PNL_COMPONENTS = [
  { key: 'hedgeRealizedPnlUsd', label: 'Hedge realizado', sign: 1 },
  { key: 'hedgeUnrealizedPnlUsd', label: 'Hedge no realizado', sign: 1 },
  { key: 'hedgeFundingUsd', label: 'Funding', sign: 1 },
  { key: 'hedgeExecutionFeesUsd', label: 'Fees ejecucion hedge', sign: -1 },
  { key: 'hedgeSlippageUsd', label: 'Slippage hedge', sign: -1 },
];

export function netPnl(accounting) {
  return Number(accounting.lpFeesUsd || 0) + Number(accounting.priceDriftUsd || 0)
    - Number(accounting.gasSpentUsd || 0) - Number(accounting.swapSlippageUsd || 0)
    + Number(accounting.hedgeRealizedPnlUsd || 0) + Number(accounting.hedgeUnrealizedPnlUsd || 0)
    + Number(accounting.hedgeFundingUsd || 0) - Number(accounting.hedgeExecutionFeesUsd || 0)
    - Number(accounting.hedgeSlippageUsd || 0);
}

/** Selecciona una política sin fabricar datos para snapshots anteriores. */
export function selectPolicySnapshot(snapshot, selectedPolicy = 'live') {
  if (!snapshot) return null;
  const policies = snapshot.breakdown?.policies;
  if (!policies) return selectedPolicy === 'live' ? snapshot : null;
  const policy = selectedPolicy === 'live'
    ? Object.values(policies).find((candidate) => candidate?.isLive)
    : policies[selectedPolicy];
  if (!policy || !Number.isFinite(Number(policy.hlAccountUsd))) return null;
  const accounting = snapshot.breakdown?.accounting;
  if (!accounting) return null;
  const selectedAccounting = {
    ...accounting,
    hedgeRealizedPnlUsd: policy.hedgeRealizedPnlUsd,
    hedgeUnrealizedPnlUsd: policy.hedgeUnrealizedPnlUsd,
    hedgeFundingUsd: policy.hedgeFundingUsd,
    hedgeExecutionFeesUsd: policy.hedgeExecutionFeesUsd,
    hedgeSlippageUsd: policy.hedgeSlippageUsd,
  };
  if (!Object.values(HEDGE_PNL_COMPONENTS).every(({ key }) => Number.isFinite(Number(selectedAccounting[key])))) return null;
  selectedAccounting.totalNetPnlUsd = netPnl(selectedAccounting);
  const hlAccountUsd = Number(policy.hlAccountUsd);
  return {
    ...snapshot,
    hlAccountUsd,
    totalUsd: Number(snapshot.walletUsd || 0) + Number(snapshot.lpUsd || 0) + hlAccountUsd,
    accounting: selectedAccounting,
    breakdown: { ...snapshot.breakdown, accounting: selectedAccounting, selectedPolicy: selectedPolicy === 'live'
      ? Object.entries(policies).find(([, candidate]) => candidate?.isLive)?.[0] : selectedPolicy },
  };
}

/**
 * Desglose legible del PnL para el tooltip nativo del stat. Incluye los
 * ajustes de capital (depositos/retiros al LP) como nota aparte: NO son PnL,
 * pero explican por que "Δ rango" y "PnL total" pueden diferir.
 */
export function buildPnlTooltip(accounting, rangeDeltaUsd, rangeLabel) {
  if (!accounting) return 'Sin contabilidad disponible';
  const lines = ['PnL neto acumulado (vida del orquestador)', ''];
  for (const { key, label, sign } of [...LP_PNL_COMPONENTS, ...HEDGE_PNL_COMPONENTS]) {
    const raw = Number(accounting[key]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    lines.push(`${label}: ${fmtSignedUsd(sign * raw)}`);
  }
  lines.push('', `Total: ${fmtSignedUsd(accounting.totalNetPnlUsd)}`);
  if (Number.isFinite(rangeDeltaUsd)) {
    lines.push(`PnL en ${rangeLabel}: ${fmtSignedUsd(rangeDeltaUsd)}`);
  }
  const capital = Number(accounting.capitalAdjustmentsUsd);
  if (Number.isFinite(capital) && capital !== 0) {
    lines.push('', `Capital agregado/retirado (no es PnL): ${fmtSignedUsd(capital)}`);
  }
  return lines.join('\n');
}
