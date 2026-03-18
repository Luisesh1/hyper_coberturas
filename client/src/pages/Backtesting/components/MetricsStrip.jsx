import { formatNumber } from '../../../utils/formatters';
import styles from './MetricsStrip.module.css';

function MetricsStrip({ metrics }) {
  if (!metrics || metrics.trades == null) {
    return <span className={styles.hint}>Configura y ejecuta tu primera simulacion</span>;
  }

  const pnlPositive = Number(metrics.netPnl) >= 0;
  const winAbove50 = Number(metrics.winRate) >= 50;

  return (
    <div className={styles.strip}>
      <div className={styles.chip}>
        <span className={styles.label}>Trades</span>
        <span className={styles.value}>{metrics.trades}</span>
      </div>
      <div className={styles.chip}>
        <span className={styles.label}>Win</span>
        <span className={`${styles.value} ${winAbove50 ? styles.positive : styles.negative}`}>
          {formatNumber(metrics.winRate, 1)}%
        </span>
      </div>
      <div className={styles.chip}>
        <span className={styles.label}>PnL</span>
        <span className={`${styles.value} ${pnlPositive ? styles.positive : styles.negative}`}>
          {pnlPositive ? '+' : ''}{formatNumber(metrics.netPnl, 2)}
        </span>
      </div>
      <div className={styles.chip}>
        <span className={styles.label}>DD</span>
        <span className={`${styles.value} ${styles.amber}`}>
          {formatNumber(metrics.maxDrawdown, 2)}
        </span>
      </div>
    </div>
  );
}

export default MetricsStrip;
