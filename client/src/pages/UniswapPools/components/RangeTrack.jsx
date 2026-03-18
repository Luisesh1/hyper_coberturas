import { getRangeBarData } from '../utils/pool-helpers';
import { formatCompactPrice } from '../utils/pool-formatters';
import styles from './RangeTrack.module.css';

export default function RangeTrack({ pool, compact = false, showOpen = true }) {
  const rangeBar = getRangeBarData(pool);
  if (!rangeBar) return null;

  return (
    <div className={`${styles.rangeCard} ${compact ? styles.rangeCardCompact : ''}`}>
      <div className={styles.rangeHeader}>
        <span className={styles.rangeTitle}>Rango</span>
        <span className={styles.rangeMeta}>
          {pool.currentOutOfRangeSide
            ? pool.currentOutOfRangeSide === 'below' ? 'Fuera por abajo' : 'Fuera por arriba'
            : 'Dentro de rango'}
        </span>
      </div>

      {!compact && (
        <div className={styles.pinsRow}>
          {showOpen && rangeBar.openPct != null && (
            <div className={styles.pin} style={{ left: `${rangeBar.openPct}%` }}>
              <span className={styles.pinValue}>{formatCompactPrice(rangeBar.openPrice)}</span>
              <span className={styles.pinLabel}>Entrada</span>
            </div>
          )}
          {rangeBar.currentPct != null && (
            <div className={`${styles.pin} ${styles.pinCurrent}`} style={{ left: `${rangeBar.currentPct}%` }}>
              <span className={styles.pinValue}>{formatCompactPrice(rangeBar.currentPrice)}</span>
              <span className={styles.pinLabel}>Actual</span>
            </div>
          )}
        </div>
      )}

      <div className={styles.track}>
        <div
          className={styles.fill}
          style={{
            left: `${rangeBar.rangeLowPct}%`,
            width: `${rangeBar.rangeHighPct - rangeBar.rangeLowPct}%`,
          }}
        />
        <div className={styles.edge} style={{ left: `${rangeBar.rangeLowPct}%` }} />
        <div className={styles.edge} style={{ left: `${rangeBar.rangeHighPct}%` }} />
        {showOpen && rangeBar.openPct != null && (
          <div className={`${styles.marker} ${styles.markerOpen}`} style={{ left: `${rangeBar.openPct}%` }} />
        )}
        {rangeBar.currentPct != null && (
          <div
            className={`${styles.marker} ${styles.markerCurrent} ${pool.currentOutOfRangeSide ? styles.markerAlert : ''}`}
            style={{ left: `${rangeBar.currentPct}%` }}
          />
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.edgeValue}>{formatCompactPrice(rangeBar.lowerPrice)}</span>
        <span className={styles.caption}>{pool.priceQuoteSymbol}/{pool.priceBaseSymbol}</span>
        <span className={styles.edgeValue}>{formatCompactPrice(rangeBar.upperPrice)}</span>
      </div>
    </div>
  );
}
