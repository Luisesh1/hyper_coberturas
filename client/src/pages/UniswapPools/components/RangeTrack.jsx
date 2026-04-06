import { getRangeBarData } from '../utils/pool-helpers';
import { formatCompactPrice } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import styles from './RangeTrack.module.css';

function getBoundedPinLeft(pct) {
  if (pct == null) return undefined;
  return `clamp(40px, ${pct}%, calc(100% - 40px))`;
}

export default function RangeTrack({ pool, compact = false, showOpen = true }) {
  const rangeBar = getRangeBarData(pool);
  if (!rangeBar) return null;
  const lowerPrice = Number(rangeBar.lowerPrice);
  const upperPrice = Number(rangeBar.upperPrice);
  const rangeWidthPct = Number.isFinite(lowerPrice) && lowerPrice > 0 && Number.isFinite(upperPrice) && upperPrice >= lowerPrice
    ? ((upperPrice - lowerPrice) / lowerPrice) * 100
    : null;

  const openPinLeft = getBoundedPinLeft(rangeBar.openPct);
  const currentPinLeft = getBoundedPinLeft(rangeBar.currentPct);

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

      {compact && showOpen && rangeBar.openPct != null && (
        <div className={`${styles.pinsRow} ${styles.pinsRowCompact}`}>
          <div className={`${styles.pin} ${styles.pinCompact}`} style={{ left: openPinLeft }}>
            <span className={styles.pinValue}>{formatCompactPrice(rangeBar.openPrice)}</span>
            <span className={styles.pinLabel}>Entrada</span>
          </div>
        </div>
      )}

      {!compact && (
        <div className={styles.pinsRow}>
          {showOpen && rangeBar.openPct != null && (
            <div className={styles.pin} style={{ left: openPinLeft }}>
              <span className={styles.pinValue}>{formatCompactPrice(rangeBar.openPrice)}</span>
              <span className={styles.pinLabel}>Entrada</span>
            </div>
          )}
          {rangeBar.currentPct != null && (
            <div className={`${styles.pin} ${styles.pinCurrent}`} style={{ left: currentPinLeft }}>
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
        <span className={styles.caption}>
          {pool.priceQuoteSymbol}/{pool.priceBaseSymbol}
          {rangeWidthPct != null ? ` · ${formatNumber(rangeWidthPct, 2)}%` : ''}
        </span>
        <span className={styles.edgeValue}>{formatCompactPrice(rangeBar.upperPrice)}</span>
      </div>
    </div>
  );
}
