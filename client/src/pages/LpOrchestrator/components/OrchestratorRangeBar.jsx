import { getRangeBarData } from '../../UniswapPools/utils/pool-helpers';
import { formatCompactPrice } from '../../UniswapPools/utils/pool-formatters';
import { formatNumber, formatDuration } from '../../../utils/formatters';
import styles from './OrchestratorRangeBar.module.css';

function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function getBoundedPinLeft(pct) {
  if (pct == null) return undefined;
  return `clamp(40px, ${pct}%, calc(100% - 40px))`;
}

/**
 * Range bar específico del orquestador. A diferencia de RangeTrack, divide
 * visualmente el rango del LP en TRES zonas controladas por la estrategia:
 *
 *   [edge_lower] | [central / no-adjustment] | [edge_upper]
 *      warn      |          ok               |     warn
 *
 * Marca dos pins: el precio de apertura del LP (ámbar) y el precio actual,
 * cuyo color refleja la zona en la que se encuentra (verde / ámbar / rojo).
 */
export default function OrchestratorRangeBar({
  pool,
  edgeMarginPct = 40,
  activeForMs = null,
  timeInRangePct = null,
}) {
  const rangeBar = getRangeBarData(pool);
  if (!rangeBar) return null;

  const { rangeLowPct, rangeHighPct, openPct, currentPct, lowerPrice, upperPrice, openPrice, currentPrice } = rangeBar;
  const rangeWidthDom = rangeHighPct - rangeLowPct;
  if (rangeWidthDom <= 0) return null;

  // Banda central: el (100 - 2*edgeMarginPct)% central del rango LP.
  const margin = Math.max(0, Math.min(49, Number(edgeMarginPct) || 0));
  const centralLowPct = rangeLowPct + (rangeWidthDom * margin) / 100;
  const centralHighPct = rangeHighPct - (rangeWidthDom * margin) / 100;

  // ¿Está el precio actual dentro del rango y en qué zona?
  // El tone se usa internamente para colorear el marker / pin del precio
  // actual; el badge de estado vive en el header de la card, no aquí, para
  // no duplicar la etiqueta de fase.
  const inRange = pool?.currentOutOfRangeSide == null;
  const inCentralBand = inRange && currentPct != null
    && currentPct >= centralLowPct && currentPct <= centralHighPct;

  let statusTone;
  if (!inRange) statusTone = 'urgent';
  else if (inCentralBand) statusTone = 'ok';
  else statusTone = 'warn';

  const rangeWidthPct = Number.isFinite(lowerPrice) && lowerPrice > 0 && Number.isFinite(upperPrice)
    ? ((upperPrice - lowerPrice) / lowerPrice) * 100
    : null;

  const openPinLeft = getBoundedPinLeft(openPct);
  const currentPinLeft = getBoundedPinLeft(currentPct);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Rango</span>
      </div>

      {/* Pin del precio actual ARRIBA del track */}
      <div className={`${styles.pinsRow} ${styles.pinsRowTop}`}>
        {currentPct != null && (
          <div className={`${styles.pin} ${styles.pinTop} ${styles[`pinCurrent_${statusTone}`]}`} style={{ left: currentPinLeft }}>
            <span className={styles.pinValue}>{formatCompactPrice(currentPrice)}</span>
            <span className={styles.pinLabel}>Actual</span>
          </div>
        )}
      </div>

      <div className={styles.track}>
        {/* Borde inferior (warning zone) */}
        <div
          className={`${styles.zone} ${styles.zoneEdge}`}
          style={{ left: `${rangeLowPct}%`, width: `${centralLowPct - rangeLowPct}%` }}
        />
        {/* Banda central (no-adjustment zone) */}
        <div
          className={`${styles.zone} ${styles.zoneCentral}`}
          style={{ left: `${centralLowPct}%`, width: `${centralHighPct - centralLowPct}%` }}
        />
        {/* Borde superior (warning zone) */}
        <div
          className={`${styles.zone} ${styles.zoneEdge}`}
          style={{ left: `${centralHighPct}%`, width: `${rangeHighPct - centralHighPct}%` }}
        />

        {/* Edges del rango LP */}
        <div className={styles.edge} style={{ left: `${rangeLowPct}%` }} />
        <div className={styles.edge} style={{ left: `${rangeHighPct}%` }} />
        {/* Edges de la banda central (líneas más suaves) */}
        <div className={styles.centralEdge} style={{ left: `${centralLowPct}%` }} />
        <div className={styles.centralEdge} style={{ left: `${centralHighPct}%` }} />

        {/* Marker de precio de apertura */}
        {openPct != null && (
          <div className={`${styles.marker} ${styles.markerOpen}`} style={{ left: `${openPct}%` }} />
        )}
        {/* Marker de precio actual coloreado según zona */}
        {currentPct != null && (
          <div
            className={`${styles.marker} ${styles[`markerCurrent_${statusTone}`]}`}
            style={{ left: `${currentPct}%` }}
          />
        )}
      </div>

      {/* Pin del precio de apertura DEBAJO del track */}
      <div className={`${styles.pinsRow} ${styles.pinsRowBottom}`}>
        {openPct != null && (
          <div className={`${styles.pin} ${styles.pinBottom} ${styles.pinOpen}`} style={{ left: openPinLeft }}>
            <span className={styles.pinLabel}>Apertura</span>
            <span className={styles.pinValue}>{formatCompactPrice(openPrice)}</span>
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.edgeValue}>{formatCompactPrice(lowerPrice)}</span>
        <span className={styles.caption}>
          {pool.priceQuoteSymbol && pool.priceBaseSymbol
            ? `${pool.priceQuoteSymbol}/${pool.priceBaseSymbol}`
            : 'precio'}
          {rangeWidthPct != null ? ` · ${formatNumber(rangeWidthPct, 2)}% · centro ${(100 - 2 * margin).toFixed(0)}%` : ''}
        </span>
        <span className={styles.edgeValue}>{formatCompactPrice(upperPrice)}</span>
      </div>

      {(activeForMs != null || timeInRangePct != null) && (
        <div className={styles.metricsRow}>
          {activeForMs != null && (
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Tiempo abierto</span>
              <span className={styles.metricValue}>{formatDuration(activeForMs)}</span>
            </div>
          )}
          {timeInRangePct != null && (
            <div className={styles.metric}>
              <span className={styles.metricLabel}>En rango</span>
              <span className={`${styles.metricValue} ${styles[`metric_${rangeBarTone(timeInRangePct)}`]}`}>
                {formatNumber(timeInRangePct, 1)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function rangeBarTone(pct) {
  if (pct == null) return 'neutral';
  if (pct >= 80) return 'ok';
  if (pct >= 50) return 'warn';
  return 'urgent';
}
