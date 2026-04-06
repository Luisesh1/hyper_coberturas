import { formatNumber, formatTimestamp, formatDuration } from '../../../utils/formatters';
import { getPoolStatus, getProtectionButtonState, getExplorerLink, getPoolValue } from '../utils/pool-helpers';
import {
  formatUsd,
  formatCompactUsd,
  formatSignedUsd,
  formatPercent,
  formatPrice,
  getValuationAccuracyBadge,
  getValuationSourceLabel,
  shortAddress,
} from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './PoolCard.module.css';

export default function PoolCard({ pool, hasAccounts, onApplyProtection, walletState, onClaimFees }) {
  const isLpPosition = pool.mode === 'lp_position' || pool.mode === 'lp_positions';
  const isV4 = pool.version === 'v4';
  const hasUnsupportedV4Hooks = isV4 && pool.hooks && pool.hooks !== '0x0000000000000000000000000000000000000000';
  const protectionState = getProtectionButtonState(pool, hasAccounts);
  const status = getPoolStatus(pool);
  const pnlValue = Number(pool.pnlTotalUsd);
  const yieldValue = Number(pool.yieldPct);
  const timeInRangePct = pool.timeInRangePct != null ? Number(pool.timeInRangePct) : null;
  const ownerValue = pool.owner || pool.creator;
  const creatorLink = getExplorerLink(pool.explorerUrl, 'address', ownerValue);
  const txLink = getExplorerLink(pool.explorerUrl, 'tx', pool.txHash);
  const poolLink = getExplorerLink(pool.explorerUrl, 'address', pool.poolAddress);
  const openPriceLabel = getValuationAccuracyBadge(pool.priceAtOpenAccuracy);
  const initialValueLabel = getValuationAccuracyBadge(pool.initialValueUsdAccuracy);
  const initialValueSource = getValuationSourceLabel(pool.initialValueUsdSource);
  const openPriceSource = getValuationSourceLabel(pool.priceAtOpenSource);
  const unclaimedFees = Number(pool.unclaimedFeesUsd);
  const canClaim = isLpPosition
    && ['v3', 'v4'].includes(pool.version)
    && walletState?.isConnected
    && walletState.chainId === pool.chainId
    && pool.owner?.toLowerCase() === walletState.address?.toLowerCase()
    && !hasUnsupportedV4Hooks
    && unclaimedFees > 0;
  const canManage = isLpPosition
    && ['v3', 'v4'].includes(pool.version)
    && walletState?.isConnected
    && walletState.chainId === pool.chainId
    && pool.owner?.toLowerCase() === walletState.address?.toLowerCase()
    && !hasUnsupportedV4Hooks;

  const toneCls = pool.protection
    ? styles.card_protected
    : status.tone === 'positive'
      ? styles.card_positive
      : status.tone === 'alert'
        ? styles.card_alert
        : '';

  const pnlTone = Number.isFinite(pnlValue) ? (pnlValue > 0 ? styles.positive : pnlValue < 0 ? styles.negative : '') : '';
  const yieldTone = Number.isFinite(yieldValue) ? (yieldValue > 0 ? styles.positive : yieldValue < 0 ? styles.negative : '') : '';

  // Tooltip for disabled manage buttons
  const manageTitle = !walletState?.isConnected
    ? 'Conecta tu wallet para gestionar esta posición'
    : walletState.chainId !== pool.chainId
      ? 'Cambia a la red correcta en tu wallet'
      : pool.owner?.toLowerCase() !== walletState.address?.toLowerCase()
        ? 'Esta wallet no es la dueña de la posición'
        : hasUnsupportedV4Hooks
          ? 'Hooks no soportados en gestión V4'
        : '';

  const lpActionButtons = [
    { action: 'increase-liquidity', label: 'Liquidez', icon: '➕', title: 'Agregar más liquidez a esta posición' },
    { action: 'decrease-liquidity', label: 'Liquidez', icon: '➖', title: 'Retirar parte de la liquidez de esta posición' },
    { action: 'reinvest-fees', label: 'Reinvertir', icon: '↻', title: 'Reinvertir las fees acumuladas en más liquidez' },
    { action: 'modify-range', label: 'Rango', icon: '↔', title: 'Cambiar el rango de precios de la posición' },
    { action: 'rebalance', label: 'Rebalancear', icon: '⚖', title: 'Rebalancear los activos de la posición' },
    { action: 'close-to-usdc', label: 'Cerrar a USDC', icon: '💵', title: 'Cerrar la posición y convertir los fondos a USDC' },
    { action: 'close-keep-assets', label: 'Cerrar LP', icon: '📦', title: 'Cerrar la posición y conservar token0/token1 en la wallet' },
  ];

  return (
    <article className={`${styles.card} ${toneCls}`}>
      <div className={styles.header}>
        <h3 className={styles.pair}>{pool.token0?.symbol ?? '?'} / {pool.token1?.symbol ?? '?'}</h3>
        <div className={styles.badges}>
          <span className={styles.badgeVersion}>{pool.version.toUpperCase()}</span>
          <span className={styles.badgeNetwork}>{pool.networkLabel}</span>
          {isV4 && <span className={styles.badgeNeutral}>PoolManager</span>}
          {hasUnsupportedV4Hooks && <span className={styles.badgeNeutral}>Hooks no soportados</span>}
          {pool.protection && <span className={styles.badgeProtected}>✓ Protegido</span>}
        </div>
      </div>

      <div className={styles.statusLine}>
        <span className={`${styles.statusDot} ${styles[`dot_${status.tone}`]}`} />
        <span className={styles.statusText}>{status.label}</span>
        {ownerValue && (
          <span className={styles.walletAddress} title={ownerValue}>{shortAddress(ownerValue)}</span>
        )}
      </div>

      <div className={styles.metrics}>
        {isLpPosition && (
          <div className={styles.metric}>
            <span className={styles.metricValueRow}>
              <span className={styles.metricValue}>{formatUsd(pool.initialValueUsd)}</span>
              {initialValueLabel && pool.initialValueUsd != null && (
                <span className={styles.metricBadge}>{initialValueLabel}</span>
              )}
            </span>
            <span className={styles.metricLabel}>Valor inicial LP</span>
          </div>
        )}
        <div className={styles.metric}>
          <span className={styles.metricValue}>
            {isLpPosition ? formatUsd(pool.currentValueUsd) : formatCompactUsd(pool.tvlApproxUsd)}
          </span>
          <span className={styles.metricLabel}>{isLpPosition ? 'Valor actual LP' : 'TVL'}</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${pnlTone}`}>{formatSignedUsd(pool.pnlTotalUsd)}</span>
          <span className={styles.metricLabel}>Ganancia / Pérdida</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${yieldTone}`}>{formatPercent(pool.yieldPct)}</span>
          <span className={styles.metricLabel}>Rendimiento</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${unclaimedFees > 0 ? styles.amber : ''}`}>{formatUsd(pool.unclaimedFeesUsd)}</span>
          <span className={styles.metricLabel}>Fees acumuladas</span>
        </div>
        {pool.activeForMs != null && (
          <div className={styles.metric}>
            <span className={styles.metricValue}>{formatDuration(pool.activeForMs)}</span>
            <span className={styles.metricLabel}>Tiempo en pool</span>
          </div>
        )}
        {timeInRangePct != null && (
          <div className={styles.metric}>
            <span className={styles.metricValue}>{timeInRangePct.toFixed(1)}%</span>
            <span className={styles.metricLabel}>Tiempo en rango</span>
          </div>
        )}
      </div>

      {isLpPosition && <RangeTrack pool={pool} compact />}

      {/* Botón principal: aplicar cobertura */}
      {protectionState && !protectionState.disabled && (
        <button
          type="button"
          className={styles.protectBtn}
          onClick={() => onApplyProtection(pool)}
        >
          <span className={styles.protectBtnIcon}>🛡</span>
          {protectionState.label}
        </button>
      )}

      {/* Razón por la que no se puede proteger */}
      {protectionState && protectionState.disabled && protectionState.reason && !pool.protection && (
        <div className={styles.protectHint}>
          <span className={styles.protectHintIcon}>ℹ</span>
          {protectionState.reason}
        </div>
      )}

      {/* Acciones LP (cobrar fees, gestionar posición) */}
      {isLpPosition && ['v3', 'v4'].includes(pool.version) && onClaimFees && (
        <div className={styles.actionGroup}>
          {hasUnsupportedV4Hooks && (
            <div className={styles.protectHint}>
              <span className={styles.protectHintIcon}>ℹ</span>
              Hooks no soportados en gestión V4
            </div>
          )}
          <button
            type="button"
            className={styles.claimBtn}
            disabled={!canClaim}
            onClick={() => onClaimFees('collect-fees', pool)}
            title={
              !walletState?.isConnected ? 'Conecta tu wallet para cobrar fees'
                : walletState.chainId !== pool.chainId ? 'Cambia a la red correcta en tu wallet'
                  : pool.owner?.toLowerCase() !== walletState.address?.toLowerCase() ? 'Esta wallet no es dueña de la posición'
                    : unclaimedFees <= 0 ? 'No hay fees acumuladas por cobrar'
                      : `Cobrar ${formatUsd(pool.unclaimedFeesUsd)} en fees acumuladas`
            }
          >
            <span>💰 Cobrar fees</span>
            {unclaimedFees > 0 && <span className={styles.claimAmount}>{formatUsd(pool.unclaimedFeesUsd)}</span>}
          </button>

          <div className={styles.manageRow}>
            {lpActionButtons.map((item) => (
              <button
                key={item.action}
                type="button"
                className={styles.secondaryBtn}
                disabled={!canManage}
                onClick={() => onClaimFees(item.action, pool)}
                title={canManage ? item.title : manageTitle}
              >
                <span className={styles.secondaryBtnIcon} aria-hidden="true">{item.icon}</span>
                <span className={styles.secondaryBtnLabel}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sección expandible con detalles */}
      <details className={styles.details}>
        <summary className={styles.detailsToggle}>
          <span>Ver detalles del pool</span>
          <span className={styles.detailsChevron}>›</span>
        </summary>
        <div className={styles.detailsContent}>
          {isLpPosition && (
            <>
              <p className={styles.insightsTitle}>Datos para la cobertura en Hyperliquid</p>
              <div className={styles.insights}>
                <div className={styles.insightItem}>
                  <span className={styles.insightLabel}>Activo en Hyperliquid</span>
                  <span className={styles.insightValue}>
                    {pool.protectionCandidate?.inferredAsset
                      ? <strong>{pool.protectionCandidate.inferredAsset}</strong>
                      : <span className={styles.insightMuted}>No se pudo inferir</span>}
                  </span>
                </div>
                <div className={styles.insightItem}>
                  <span className={styles.insightLabel}>Valor posición LP</span>
                  <span className={styles.insightValue}>{formatUsd(pool.protectionCandidate?.baseNotionalUsd)}</span>
                </div>
                <div className={styles.insightItem}>
                  <span className={styles.insightLabel}>Distancia al límite del rango</span>
                  <span className={styles.insightValue}>
                    {pool.distanceToRangePct === 0
                      ? <span className={styles.positive}>Dentro del rango activo</span>
                      : pool.distanceToRangePct != null
                        ? `${formatNumber(pool.distanceToRangePrice, 4)} · ${formatPercent(pool.distanceToRangePct)}`
                        : '—'}
                  </span>
                </div>
                <div className={styles.insightItem}>
                  <span className={styles.insightLabel}>Tamaño estimado de cobertura</span>
                  <span className={styles.insightValue}>
                    {pool.protectionCandidate?.hedgeSize != null && pool.protectionCandidate?.inferredAsset
                      ? `${formatNumber(pool.protectionCandidate.hedgeSize, 6)} ${pool.protectionCandidate.inferredAsset}`
                      : '—'}
                  </span>
                </div>
              </div>
            </>
          )}

          {isLpPosition && <RangeTrack pool={pool} />}

          <p className={styles.insightsTitle}>Datos on-chain</p>
          <div className={styles.advancedGrid}>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>{isLpPosition ? 'Propietario' : 'Creador'}</span>
              {creatorLink ? (
                <a className={styles.advancedLink} href={creatorLink} target="_blank" rel="noreferrer" title={ownerValue}>
                  {shortAddress(ownerValue)} ↗
                </a>
              ) : (
                <span className={styles.advancedValue}>{shortAddress(ownerValue)}</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Transacción de apertura</span>
              {txLink ? (
                <a className={styles.advancedLink} href={txLink} target="_blank" rel="noreferrer" title={pool.txHash}>
                  {shortAddress(pool.txHash)} ↗
                </a>
              ) : (
                <span className={styles.advancedValue}>No disponible</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>{isV4 ? 'ID del pool (V4)' : 'Contrato del pool'}</span>
              {poolLink ? (
                <a className={styles.advancedLink} href={poolLink} target="_blank" rel="noreferrer" title={pool.poolAddress || pool.identifier}>
                  {shortAddress(pool.poolAddress || pool.identifier)} ↗
                </a>
              ) : (
                <span className={styles.advancedValue}>{shortAddress(pool.poolAddress || pool.identifier)}</span>
              )}
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Comisión del pool / Tick spacing</span>
              <span className={styles.advancedValue}>
                {pool.fee != null ? `${pool.fee} bps (${(pool.fee / 10000).toFixed(2)}%)` : '—'}
                {pool.tickSpacing != null ? ` · tick ${pool.tickSpacing}` : ''}
              </span>
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Reservas totales del pool</span>
              <span className={styles.advancedValue}>
                {pool.reserve0 != null || pool.reserve1 != null
                  ? `${formatNumber(pool.reserve0, 4)} ${pool.token0?.symbol ?? '?'} · ${formatNumber(pool.reserve1, 4)} ${pool.token1?.symbol ?? '?'}`
                  : 'No disponible'}
              </span>
            </div>
            <div className={styles.advancedItem}>
              <span className={styles.advancedLabel}>Precio actual</span>
              <span className={styles.advancedValue}>
                {isLpPosition
                  ? formatPrice(pool.priceCurrent ?? pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)
                  : formatPrice(pool.priceApprox, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
              </span>
            </div>
            {isLpPosition && (
              <>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Precio al abrir posición</span>
                  <span className={styles.advancedValue}>
                    {formatPrice(pool.priceAtOpen, pool.priceBaseSymbol, pool.priceQuoteSymbol)}
                    {openPriceLabel ? <span className={styles.accuracy}> · {openPriceLabel}</span> : ''}
                  </span>
                </div>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Origen del valor inicial</span>
                  <span className={styles.advancedValue}>{initialValueSource}</span>
                </div>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Origen del precio de apertura</span>
                  <span className={styles.advancedValue}>{openPriceSource}</span>
                </div>
                <div className={styles.advancedItem}>
                  <span className={styles.advancedLabel}>Composición actual de la posición</span>
                  <span className={styles.advancedValue}>
                    {formatNumber(pool.positionAmount0, 6)} {pool.token0?.symbol ?? '?'} · {formatNumber(pool.positionAmount1, 6)} {pool.token1?.symbol ?? '?'}
                  </span>
                </div>
              </>
            )}
          </div>
          {Array.isArray(pool.valuationWarnings) && pool.valuationWarnings.length > 0 && (
            <>
              <p className={styles.insightsTitle}>Notas de valuación</p>
              <div className={styles.warningList}>
                {pool.valuationWarnings.map((warning) => (
                  <p key={warning} className={styles.warningItem}>{warning}</p>
                ))}
              </div>
            </>
          )}
        </div>
      </details>
    </article>
  );
}
