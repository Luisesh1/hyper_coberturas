import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { calcCyclePnl, fmt } from './constants';
import styles from './HedgePanel.module.css';

/* -- Fila de ciclo completado -- */
export function CycleRow({ cycle, hedgeSize }) {
  const isLong = cycle.direction === 'long';
  const sz     = hedgeSize ?? cycle.size ?? 0;
  const { gross, fees, funding, net } = calcCyclePnl(cycle, sz, cycle.direction);
  const openPrice = Number.isFinite(parseFloat(cycle.openPrice)) ? parseFloat(cycle.openPrice) : null;
  const closePrice = Number.isFinite(parseFloat(cycle.closePrice)) ? parseFloat(cycle.closePrice) : null;

  const durationMs = (cycle.closedAt || 0) - (cycle.openedAt || 0);
  const mins  = Math.floor(durationMs / 60000);
  const hours = Math.floor(mins / 60);
  const duration = hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`;

  const hasFeeData = (cycle.entryFee || 0) + (cycle.exitFee || 0) > 0 || cycle.closedPnl != null;

  return (
    <div className={styles.cycleRow}>
      {/* Izquierda: identificacion */}
      <div className={styles.cycleLeft}>
        <span className={styles.cycleAsset}>{cycle.asset}</span>
        <span className={`${styles.cycleBadge} ${isLong ? styles.cycleBadgeLong : ''}`}>
          {isLong ? 'LONG' : 'SHORT'} {cycle.leverage}x · #{cycle.cycleId}
        </span>
        {cycle.account && <span className={styles.cycleAccount}>{formatAccountIdentity(cycle.account)}</span>}
        {cycle.label && <span className={styles.cycleLabel}>{cycle.label}</span>}
        <span className={styles.cycleDuration}>{duration}</span>
      </div>

      {/* Derecha: PnL detallado */}
      <div className={styles.cycleRight}>
        {net != null && (
          <span className={net >= 0 ? styles.cycleProfit : styles.cycleLoss}>
            {fmt(net, 4)} USDC
          </span>
        )}
        <span className={styles.cyclePrices}>
          {openPrice != null
            ? `$${openPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : 'N/A'}
          {' → '}
          {closePrice != null
            ? `$${closePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : 'N/A'}
        </span>
        {hasFeeData && (
          <span className={styles.cycleBreakdown}>
            {gross != null && `bruto ${fmt(gross, 2)}`}
            {fees > 0 && ` · fees -${fees.toFixed(4)}`}
            {funding !== 0 && ` · fund ${fmt(funding, 4)}`}
          </span>
        )}
        {cycle.totalSlippage > 0 && (
          <span className={styles.cycleBreakdown}>
            slip -{cycle.totalSlippage.toFixed(4)} USDC
            {' '}(E:±{(cycle.entrySlippage || 0).toFixed(4)} / S:±{(cycle.exitSlippage || 0).toFixed(4)})
          </span>
        )}
        <span className={styles.cycleDuration}>{new Date(cycle.closedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
