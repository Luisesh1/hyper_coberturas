import { formatNumber, formatTimestamp, formatDuration } from '../../../utils/formatters';
import { getPoolStatus, getProtectionButtonState, getExplorerLink, getPoolValue } from '../utils/pool-helpers';
import { formatUsd, formatCompactUsd, formatSignedUsd, formatPercent, formatPrice, shortAddress } from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './PoolCard.module.css';

export default function PoolCard({ pool, hasAccounts, onApplyProtection }) {
  const isLpPosition = pool.mode === 'lp_position' || pool.mode === 'lp_positions';
  const isV4 = pool.version === 'v4';
  const protectionState = getProtectionButtonState(pool, hasAccounts);
  const status = getPoolStatus(pool);
  const pnlValue = Number(pool.pnlTotalUsd);
  const yieldValue = Number(pool.yieldPct);
  const ownerValue = pool.owner || pool.creator;
  const creatorLink = getExplorerLink(pool.explorerUrl, 'address', ownerValue);
  const txLink = getExplorerLink(pool.explorerUrl, 'tx', pool.txHash);
  const poolLink = getExplorerLink(pool.explorerUrl, 'address', pool.poolAddress);
  const openPriceLabel = pool.priceAtOpenAccuracy === 'approximate' ? 'Aprox.' : pool.priceAtOpenAccuracy === 'exact' ? 'Exacto' : null;

  const toneCls = pool.protection
    ? styles.card_protected
    : status.tone === 'positive'
      ? styles.card_positive
      : status.tone === 'alert'
        ? styles.card_alert
        : '';

  const pnlTone = Number.isFinite(pnlValue) ? (pnlValue > 0 ? styles.positive : pnlValue < 0 ? styles.negative : '') : '';
  const yieldTone = Number.isFinite(yieldValue) ? (yieldValue > 0 ? styles.positive : yieldValue < 0 ? styles.negative : '') : '';

  return (
    <article className={`${styles.card} ${toneCls}`}>
      <div className={styles.header}>
        <h3 className={styles.pair}>{pool.token0?.symbol ?? '?'} / {pool.token1?.symbol ?? '?'}</h3>
        <div className={styles.badges}>
          <span className={styles.badgeVersion}>{pool.version.toUpperCase()}</span>
          <span className={styles.badgeNetwork}>{pool.networkLabel}</span>
          {isV4 && <span className={styles.badgeNeutral}>PoolManager</span>}
          {pool.protection && <span className={styles.badgeProtected}>Protegido</span>}
        </div>
      </div>

      <div className={styles.statusLine}>
        <span className={`${styles.statusDot} ${styles[`dot_${status.tone}`]}`} />
        <span className={styles.statusText}>{status.label}</span>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>
            {isLpPosition ? formatUsd(pool.currentValueUsd) : formatCompactUsd(pool.tvlApproxUsd)}
          </span>
          <span className={styles.metricLabel}>{isLpPosition ? 'Valor' : 'TVL'}</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${pnlTone}`}>{formatSignedUsd(pool.pnlTotalUsd)}</span>
          <span className={styles.metricLabel}>P&L</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${yieldTone}`}>{formatPercent(pool.yieldPct)}</span>
          <span className={styles.metricLabel}>Yield</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatUsd(pool.unclaimedFeesUsd)}</span>
          <span className={styles.metricLabel}>Fees</span>
        </div>
        {pool.activeForMs != null && (
          <div className={styles.metric}>
            <span className={styles.metricValue}>{formatDuration(pool.activeForMs)}</span>
            <span className={styles.metricLabel}>En pool</span>
          </div>
        )}
      </div>

      {isLpPosition && <RangeTrack pool={pool} compact />}

      {protectionState && !protectionState.disabled && (
        <button
          type="button"
          className={styles.protectBtn}
          onClick={() => onApplyProtection(pool)}
        >
          {protectionState.label}
        </button>
      )}

      {protectionState && protectionState.disabled && protectionState.reason && !pool.protection && (
        <span className={styles.protectHint}>{protectionState.reason}</span>
      )}

      <details className={styles.details}>
        <summary className={styles.detailsToggle}>Mas detalles</summary>
        <div className={styles.detailsContent}>
          {isLpPosition && (
            <div className={styles.insights}>
              <div className={styles.insightItem}>
                <span className={styles.insightLabel}>HL inferido</span>
                <span className={styles.insightValue}>{pool.protectionCandidate?.inferredAsset || 'No inferible'}</span>
              </div>
              <div className={styles.insightItem}>
                <span className={styles.insightLabel}>Valor base LP</span>
                <span className={styles.insightValue}>{formatUsd(pool.protectionCandidate?.baseNotionalUsd)}</span>
              </div>
              <div className={styles.insightItem}>
                <span className={styles.insightLabel}>Distancia</span>
                <span className={styles.insightValue}>
                  {pool.distanceToRangePct === 0
                    ? 'Dentro de rango'
                    : pool.distanceToRangePct != null
                      ? `${formatNumber(pool.distanceToRangePrice, 4)} · ${formatPercent(pool.distanceToRangePct)}`
                      : 'No disponible'}
                </span>
              </div>
              <div className={styles.insightItem}>
                <span className={styles.insightLabel}>Tamano base</span>
                <span className={styles.insightValue}>
                  {pool.protectionCandidate?.hedgeSize != null && pool.protectionCandidate?.inferredAsset
                    ? `${formatNumber(pool.protectionCandidate.hedgeSize, 6)} ${pool.protectionCandidate.inferredAsset}`
                    : '—'}
                </span>
              </div>
            </div>
          )}

          {isLpPosition && <RangeTrack pool={pool} />}

          <div className={styles.advancedGrid}>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>{isLpPosition ? 'Owner' : 'Creador'}</span>
              {creatorLink ? (
                <a className={styles.advancedLink} href={creatorLink} target="_blank" rel="noreferrer">{shortAddress(ownerValue)}</a>
              ) : (
                <span className={styles.advancedValue}>{shortAddress(ownerValue)}</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Transaccion</span>
              {txLink ? (
                <a className={styles.advancedLink} href={txLink} target="_blank" rel="noreferrer">{shortAddress(pool.txHash)}</a>
              ) : (
                <span className={styles.advancedValue}>No cargado</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>{isV4 ? 'Pool ID' : 'Pool'}</span>
              {poolLink ? (
                <a className={styles.advancedLink} href={poolLink} target="_blank" rel="noreferrer">{shortAddress(pool.poolAddress || pool.identifier)}</a>
              ) : (
                <span className={styles.advancedValue}>{shortAddress(pool.poolAddress || pool.identifier)}</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Fee / Tick</span>
              <span className={styles.advancedValue}>
                {pool.fee != null ? `${pool.fee} bps` : '—'}
                {pool.tickSpacing != null ? ` · tick ${pool.tickSpacing}` : ''}
              </span>
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Reservas</span>
              <span className={styles.advancedValue}>
                {pool.reserve0 != null || pool.reserve1 != null
                  ? `${formatNumber(pool.reserve0, 4)} ${pool.token0?.symbol ?? '?'} · ${formatNumber(pool.reserve1, 4)} ${pool.token1?.symbol ?? '?'}`
                  : 'No disponible'}
              </span>
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Precio</span>
              <span className={styles.advancedValue}>
                {isLpPosition
                  ? formatPrice(pool.priceCurrent ?? pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)
                  : formatPrice(pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
              </span>
            </div>
            {isLpPosition && (
              <>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Precio al abrir</span>
                  <span className={styles.advancedValue}>
                    {formatPrice(pool.priceAtOpen, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
                    {openPriceLabel ? ` · ${openPriceLabel}` : ''}
                  </span>
                </div>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Breakdown</span>
                  <span className={styles.advancedValue}>
                    {formatNumber(pool.positionAmount0, 6)} {pool.token0?.symbol ?? '?'} · {formatNumber(pool.positionAmount1, 6)} {pool.token1?.symbol ?? '?'}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </details>
    </article>
  );
}
