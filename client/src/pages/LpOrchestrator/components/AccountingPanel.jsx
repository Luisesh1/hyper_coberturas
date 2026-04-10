import { formatUsd, formatSignedUsd } from '../../UniswapPools/utils/pool-formatters';
import { formatDuration } from '../../../utils/formatters';
import styles from './AccountingPanel.module.css';

function signTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
}

/**
 * Formato detallado para edades del orquestador (días/horas/minutos), más
 * informativo que `formatDuration` para vidas largas.
 */
function formatOrchestratorAge(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const totalMinutes = Math.floor(numeric / 60_000);
  if (totalMinutes < 1) return '< 1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export default function AccountingPanel({
  accounting,
  createdAt = null,
  initialTotalUsd = null,
  unclaimedFeesUsd = null,
  compact = false,
}) {
  const a = accounting || {};
  const hasHedgeData =
    Number(a.hedgeRealizedPnlUsd) !== 0
    || Number(a.hedgeUnrealizedPnlUsd) !== 0
    || Number(a.hedgeFundingUsd) !== 0
    || Number(a.hedgeExecutionFeesUsd) !== 0
    || Number(a.hedgeSlippageUsd) !== 0;

  // Yield del LP solo por fees: lo que rindió el capital inicial en fees
  // brutas, sin contar gas, slippage ni deriva de precio. Útil para comparar
  // contra una APR de referencia.
  const initial = Number(initialTotalUsd);
  const lpFees = Number(a.lpFeesUsd) || 0;
  const feesYieldPct = Number.isFinite(initial) && initial > 0
    ? (lpFees / initial) * 100
    : null;

  const pendingFees = Number(unclaimedFeesUsd);
  const hasPendingFees = Number.isFinite(pendingFees) && pendingFees > 0;

  const lpItems = [
    { label: 'Fees LP ganadas', value: formatUsd(a.lpFeesUsd), tone: 'positive' },
  ];
  if (hasPendingFees) {
    lpItems.push({
      label: 'Fees pendientes de cobrar',
      value: formatUsd(pendingFees),
      tone: 'positive',
    });
  }
  lpItems.push(
    { label: 'Gas gastado', value: `-${formatUsd(a.gasSpentUsd)}`, tone: 'negative' },
    { label: 'Slippage swaps', value: `-${formatUsd(a.swapSlippageUsd)}`, tone: 'negative' },
    { label: 'Deriva de precio', value: formatSignedUsd(a.priceDriftUsd), tone: signTone(a.priceDriftUsd) },
  );
  if (Number(a.capitalAdjustmentsUsd) !== 0) {
    lpItems.push({
      label: 'Capital ajustado',
      value: formatSignedUsd(a.capitalAdjustmentsUsd),
      tone: signTone(a.capitalAdjustmentsUsd),
    });
  }
  if (feesYieldPct != null) {
    lpItems.push({
      label: 'Yield fees',
      value: `${feesYieldPct >= 0 ? '+' : ''}${feesYieldPct.toFixed(2)}%`,
      tone: feesYieldPct > 0 ? 'positive' : 'neutral',
    });
  }

  const hedgeItems = [
    { label: 'Hedge realizado', value: formatSignedUsd(a.hedgeRealizedPnlUsd), tone: signTone(a.hedgeRealizedPnlUsd) },
    { label: 'Hedge no realizado', value: formatSignedUsd(a.hedgeUnrealizedPnlUsd), tone: signTone(a.hedgeUnrealizedPnlUsd) },
    { label: 'Funding hedge', value: formatSignedUsd(a.hedgeFundingUsd), tone: signTone(a.hedgeFundingUsd) },
    { label: 'Fees ejecución', value: `-${formatUsd(a.hedgeExecutionFeesUsd)}`, tone: 'negative' },
    { label: 'Slippage hedge', value: `-${formatUsd(a.hedgeSlippageUsd)}`, tone: 'negative' },
  ];

  return (
    <div className={`${styles.root} ${compact ? styles.compact : ''}`}>
      <div className={styles.header}>
        <span className={styles.label}>Contabilidad acumulada</span>
        <span className={styles.lpCount}>LPs: {a.lpCount ?? 0}</span>
      </div>

      <Section title="LP" tone="cyan">
        <div className={styles.grid}>
          {lpItems.map((item) => <Cell key={item.label} {...item} />)}
        </div>
      </Section>

      {hasHedgeData && (
        <Section title="Protección (delta-neutral)" tone="amber">
          <div className={styles.grid}>
            {hedgeItems.map((item) => <Cell key={item.label} {...item} />)}
          </div>
        </Section>
      )}

      {createdAt != null && (
        <div className={styles.lifetimeRow}>
          <span className={styles.lifetimeLabel}>⏱ Tiempo activo del orquestador</span>
          <strong className={styles.lifetimeValue}>
            {formatOrchestratorAge(Date.now() - Number(createdAt))}
          </strong>
        </div>
      )}

      <div className={styles.netRow}>
        <span>P&amp;L neto total</span>
        <strong className={signTone(a.totalNetPnlUsd) === 'negative' ? styles.negative : styles.positive}>
          {formatSignedUsd(a.totalNetPnlUsd)}
        </strong>
      </div>
    </div>
  );
}

function Section({ title, tone, children }) {
  return (
    <div className={`${styles.section} ${styles[`section_${tone}`]}`}>
      <span className={styles.sectionTitle}>{title}</span>
      {children}
    </div>
  );
}

function Cell({ label, value, tone }) {
  return (
    <div className={styles.cell}>
      <span className={styles.cellLabel}>{label}</span>
      <span className={`${styles.cellValue} ${styles[tone] || ''}`}>{value}</span>
    </div>
  );
}
