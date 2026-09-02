import { formatUsd, formatSignedUsd } from '../../UniswapPools/utils/pool-formatters';
import { formatOrchestratorAge } from './orchestratorAge';
import styles from './AccountingPanel.module.css';

/** Number() a secas convierte los ausentes en NaN, y `NaN !== 0` es true:
 *  bastaba con que un campo no viniera para que una sección se diera por
 *  poblada y se dibujara vacía. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Porcentaje con signo explicito. El `+` importa: sin el, un `0.84%` al lado
 *  de un importe negativo se lee como si fueran de signos distintos. */
function formatSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}%`;
}

function signTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
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
    num(a.hedgeRealizedPnlUsd) !== 0
    || num(a.hedgeUnrealizedPnlUsd) !== 0
    || num(a.hedgeFundingUsd) !== 0
    || num(a.hedgeExecutionFeesUsd) !== 0
    || num(a.hedgeSlippageUsd) !== 0;

  // Neto de cada pata de cobertura con la misma convención que usa el motor:
  // realizado + latente + funding − comisiones − slippage. El P&L del LP no
  // entra: es idéntico bajo las dos políticas y solo diluiría la diferencia.
  const hedgeNetUsd =
    num(a.hedgeRealizedPnlUsd)
    + num(a.hedgeUnrealizedPnlUsd)
    + num(a.hedgeFundingUsd)
    - num(a.hedgeExecutionFeesUsd)
    - num(a.hedgeSlippageUsd);

  // Yield del LP solo por fees: lo que rindió el capital inicial en fees
  // brutas, sin contar gas, slippage ni deriva de precio. Útil para comparar
  // contra una APR de referencia.
  const initial = Number(initialTotalUsd);
  const lpFees = Number(a.lpFeesUsd) || 0;
  const feesYieldPct = Number.isFinite(initial) && initial > 0
    ? (lpFees / initial) * 100
    : null;

  // El neto total tambien como % del capital inicial. Los dolares solos no
  // dicen si un resultado es bueno: -$7 es distinto en un LP de $300 que en uno
  // de $1000. Mismo denominador que `feesYieldPct` para que las dos cifras del
  // panel se puedan comparar entre si.
  const netPnl = Number(a.totalNetPnlUsd);
  const netPnlPct = Number.isFinite(initial) && initial > 0 && Number.isFinite(netPnl)
    ? (netPnl / initial) * 100
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
          <div className={styles.sectionFooter}>
            <span>Neto de cobertura</span>
            <strong className={styles[signTone(hedgeNetUsd)]}>{formatSignedUsd(hedgeNetUsd)}</strong>
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
        <span>P&L neto total</span>
        <strong className={signTone(a.totalNetPnlUsd) === 'negative' ? styles.negative : styles.positive}>
          {formatSignedUsd(a.totalNetPnlUsd)}
          {netPnlPct != null && (
            <span className={styles.netPct}>{formatSignedPct(netPnlPct)}</span>
          )}
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
