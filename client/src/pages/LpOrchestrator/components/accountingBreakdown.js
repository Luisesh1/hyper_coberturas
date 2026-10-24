import { formatUsd, formatSignedUsd } from '../../UniswapPools/utils/pool-formatters';

/**
 * Filas del desglose de P&L con sus rótulos. Las comparten `AccountingPanel`
 * (acumulado) y `SegmentsSection` (por tramo) para que no discrepen.
 */

export function signTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
}

/** `pendingFeesUsd` y `feesYieldPct` son opcionales: solo el acumulado los tiene. */
export function lpBreakdownItems(a, { pendingFeesUsd = null, feesYieldPct = null } = {}) {
  const items = [{ label: 'Fees LP ganadas', value: formatUsd(a.lpFeesUsd), tone: 'positive' }];
  if (Number.isFinite(pendingFeesUsd) && pendingFeesUsd > 0) {
    items.push({ label: 'Fees pendientes de cobrar', value: formatUsd(pendingFeesUsd), tone: 'positive' });
  }
  items.push(
    { label: 'Gas gastado', value: `-${formatUsd(a.gasSpentUsd)}`, tone: 'negative' },
    { label: 'Slippage swaps', value: `-${formatUsd(a.swapSlippageUsd)}`, tone: 'negative' },
    { label: 'Deriva de precio', value: formatSignedUsd(a.priceDriftUsd), tone: signTone(a.priceDriftUsd) },
  );
  if (Number(a.capitalAdjustmentsUsd) !== 0 && a.capitalAdjustmentsUsd != null) {
    items.push({
      label: 'Capital ajustado',
      value: formatSignedUsd(a.capitalAdjustmentsUsd),
      tone: signTone(a.capitalAdjustmentsUsd),
    });
  }
  if (feesYieldPct != null) {
    items.push({
      label: 'Yield fees',
      value: `${feesYieldPct >= 0 ? '+' : ''}${feesYieldPct.toFixed(2)}%`,
      tone: feesYieldPct > 0 ? 'positive' : 'neutral',
    });
  }
  return items;
}

export function hedgeBreakdownItems(a) {
  return [
    { label: 'Hedge realizado', value: formatSignedUsd(a.hedgeRealizedPnlUsd), tone: signTone(a.hedgeRealizedPnlUsd) },
    { label: 'Hedge no realizado', value: formatSignedUsd(a.hedgeUnrealizedPnlUsd), tone: signTone(a.hedgeUnrealizedPnlUsd) },
    { label: 'Funding hedge', value: formatSignedUsd(a.hedgeFundingUsd), tone: signTone(a.hedgeFundingUsd) },
    { label: 'Fees ejecución', value: `-${formatUsd(a.hedgeExecutionFeesUsd)}`, tone: 'negative' },
    { label: 'Slippage hedge', value: `-${formatUsd(a.hedgeSlippageUsd)}`, tone: 'negative' },
  ];
}
