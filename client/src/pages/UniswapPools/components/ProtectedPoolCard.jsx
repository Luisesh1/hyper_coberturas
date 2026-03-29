import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { STATUS_LABEL } from '../../../components/HedgePanel/constants';
import { getPoolStatus } from '../utils/pool-helpers';
import { formatDuration, formatNumber } from '../../../utils/formatters';
import {
  formatUsd, formatSignedUsd, formatPercent, formatPercentRatio,
  formatCompactPrice, formatRelativeTimestamp,
} from '../utils/pool-formatters';
import RangeTrack from './RangeTrack';
import styles from './ProtectedPoolCard.module.css';

function ProtectionStatus({ hedge }) {
  if (!hedge) return <span className={styles.hedgeEmpty}>Sin crear</span>;
  const statusInfo = STATUS_LABEL[hedge.status] || { text: hedge.status, color: '#94a3b8' };
  return <span className={styles.hedgeStatus} style={{ color: statusInfo.color }}>● {statusInfo.text}</span>;
}

export default function ProtectedPoolCard({ protection, isDeactivating, onDeactivate }) {
  const snapshot = protection.poolSnapshot || {};
  const pairLabel = snapshot.token0?.symbol && snapshot.token1?.symbol
    ? `${snapshot.token0.symbol} / ${snapshot.token1.symbol}`
    : `${protection.token0Symbol} / ${protection.token1Symbol}`;
  const pnlValue = Number(snapshot.pnlTotalUsd);
  const yieldValue = Number(snapshot.yieldPct);
  const downside = protection.hedges?.downside;
  const upside = protection.hedges?.upside;
  const status = getPoolStatus({
    ...snapshot,
    status: protection.status,
    inRange: snapshot.inRange,
    currentOutOfRangeSide: snapshot.currentOutOfRangeSide,
  });

  const toneCls = protection.status === 'active'
    ? status.tone === 'alert' ? styles.card_alert : styles.card_protected
    : '';

  const pnlTone = Number.isFinite(pnlValue) ? (pnlValue > 0 ? styles.positive : pnlValue < 0 ? styles.negative : '') : '';
  const yieldTone = Number.isFinite(yieldValue) ? (yieldValue > 0 ? styles.positive : yieldValue < 0 ? styles.negative : '') : '';
  const isDynamic = protection.protectionMode === 'dynamic';
  const isDeltaNeutral = protection.protectionMode === 'delta_neutral';
  const dynamicState = protection.dynamicState || null;
  const strategyState = protection.strategyState || null;
  const netTone = Number.isFinite(Number(strategyState?.netProtectionPnlUsd))
    ? (Number(strategyState?.netProtectionPnlUsd) > 0 ? styles.positive : Number(strategyState?.netProtectionPnlUsd) < 0 ? styles.negative : '')
    : '';
  const topUpCap = strategyState?.topUpCapUsd ?? Math.max(300, 0.25 * Number(protection.initialConfiguredHedgeNotionalUsd || protection.configuredHedgeNotionalUsd || 0));

  return (
    <article className={`${styles.card} ${toneCls}`}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.pair}>{pairLabel}</h3>
          <div className={styles.badges}>
            <span className={styles.badgeVersion}>{protection.version.toUpperCase()}</span>
            <span className={styles.badgeNetwork}>{snapshot.networkLabel || protection.network}</span>
            {isDynamic && <span className={styles.badgeDynamic}>Dinámica</span>}
            {isDeltaNeutral && <span className={styles.badgeDynamic}>Delta Neutral</span>}
            <span className={protection.status === 'active' ? styles.badgeProtected : styles.badgeNeutral}>
              {protection.status === 'active' ? 'Activa' : 'Inactiva'}
            </span>
          </div>
        </div>
        <div className={styles.actions}>
          <span className={styles.refreshMeta}>Act. {formatRelativeTimestamp(protection.updatedAt)}</span>
          {protection.status === 'active' && (
            <button type="button" className={styles.dangerBtn} onClick={() => onDeactivate(protection)} disabled={isDeactivating}>
              {isDeactivating ? 'Desactivando...' : 'Desactivar'}
            </button>
          )}
        </div>
      </div>

      <div className={styles.statusLine}>
        <span className={`${styles.statusDot} ${styles[`dot_${status.tone}`]}`} />
        <span className={styles.statusText}>{status.label}</span>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatUsd(snapshot.initialValueUsd)}</span>
          <span className={styles.metricLabel}>Inicial</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatUsd(snapshot.currentValueUsd)}</span>
          <span className={styles.metricLabel}>Actual</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatUsd(snapshot.unclaimedFeesUsd)}</span>
          <span className={styles.metricLabel}>Fees</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${pnlTone}`}>{formatSignedUsd(snapshot.pnlTotalUsd)}</span>
          <span className={styles.metricLabel}>P&L</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${yieldTone}`}>{formatPercent(snapshot.yieldPct)}</span>
          <span className={styles.metricLabel}>Yield</span>
        </div>
        {snapshot.activeForMs != null && (
          <div className={styles.metric}>
            <span className={styles.metricValue}>{formatDuration(snapshot.activeForMs)}</span>
            <span className={styles.metricLabel}>En pool</span>
          </div>
        )}
      </div>

      {snapshot.mode === 'lp_position' && <RangeTrack pool={snapshot} compact showOpen={false} />}

      <details className={styles.details}>
        <summary className={styles.detailsToggle}>Configuracion y hedges</summary>
        <div className={styles.detailsContent}>
          <div className={styles.metaGrid}>
            <div className={styles.metaChip}><span>Cuenta</span><strong>{formatAccountIdentity(protection.account)}</strong></div>
            <div className={styles.metaChip}><span>Activo HL</span><strong>{protection.inferredAsset}</strong></div>
            <div className={styles.metaChip}><span>Notional</span><strong>{formatUsd(protection.configuredHedgeNotionalUsd)}</strong></div>
            <div className={styles.metaChip}><span>Leverage</span><strong>{protection.leverage}x {protection.marginMode}</strong></div>
            {!isDeltaNeutral && <div className={styles.metaChip}><span>SL diff</span><strong>{formatPercentRatio(protection.stopLossDifferencePct)}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Fase dinámica</span><strong>{dynamicState?.phase || 'neutral'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Dist. breakout</span><strong>{protection.breakoutConfirmDistancePct != null ? `${protection.breakoutConfirmDistancePct}%` : '0.5%'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Tiempo breakout</span><strong>{protection.breakoutConfirmDurationSec != null ? formatDuration(protection.breakoutConfirmDurationSec * 1000) : '10m'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Ult. borde</span><strong>{dynamicState?.lastBrokenEdge || '—'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Reentrada</span><strong>{formatCompactPrice(dynamicState?.currentReentryPrice)}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Breakout pendiente</span><strong>{dynamicState?.pendingBreakoutEdge || '—'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Recovery</span><strong>{dynamicState?.recoveryStatus || 'OK'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Estado overlay</span><strong>{strategyState?.status || 'healthy'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Delta LP</span><strong>{strategyState?.lastDeltaQty != null ? formatNumber(strategyState.lastDeltaQty, 6) : '—'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Gamma</span><strong>{strategyState?.lastGamma != null ? formatNumber(strategyState.lastGamma, 8) : '—'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Banda efectiva</span><strong>{strategyState?.effectiveBandPct != null ? `${formatNumber(strategyState.effectiveBandPct, 2)}%` : '—'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>RV 4h / 24h</span><strong>{strategyState?.rv4hPct != null ? `${formatNumber(strategyState.rv4hPct, 1)} / ${formatNumber(strategyState.rv24hPct, 1)}%` : '—'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Funding</span><strong>{formatSignedUsd(strategyState?.fundingAccumUsd)}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Dist. liquidación</span><strong>{strategyState?.distanceToLiqPct != null ? `${formatNumber(strategyState.distanceToLiqPct, 2)}%` : '—'}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>P&L neto</span><strong className={netTone}>{formatSignedUsd(strategyState?.netProtectionPnlUsd)}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Top-up auto</span><strong>{`${formatUsd(strategyState?.topUpUsd24h)} / ${formatUsd(topUpCap)}`}</strong></div>}
            {isDeltaNeutral && <div className={styles.metaChip}><span>Conteo top-up</span><strong>{`${strategyState?.topUpCount24h || 0} / 3`}</strong></div>}
            <div className={styles.metaChip}>
              <span>Origen</span>
              <strong>{protection.valueMultiplier ? `${protection.valueMultiplier}x LP` : 'Manual / base LP'}</strong>
            </div>
          </div>

          {!isDeltaNeutral && <div className={styles.hedges}>
            <div className={styles.hedgeRow}>
              <div>
                <span className={styles.hedgeRoleDown}>Proteccion baja</span>
                <p className={styles.hedgeText}>
                  SHORT entra en {formatCompactPrice(downside?.entryPrice || protection.rangeLowerPrice)} y SL en {formatCompactPrice(downside?.exitPrice)}
                </p>
                {isDynamic && (
                  <p className={styles.hedgeText}>
                    Ancla dinámica: {formatCompactPrice(downside?.dynamicAnchorPrice || downside?.entryPrice || protection.rangeLowerPrice)}
                  </p>
                )}
              </div>
              <div className={styles.hedgeSide}>
                <ProtectionStatus hedge={downside} />
                {downside?.id && <span className={styles.hedgeId}>#{downside.id}</span>}
              </div>
            </div>

            <div className={styles.hedgeRow}>
              <div>
                <span className={styles.hedgeRoleUp}>Proteccion alza</span>
                <p className={styles.hedgeText}>
                  LONG entra en {formatCompactPrice(upside?.entryPrice || protection.rangeUpperPrice)} y SL en {formatCompactPrice(upside?.exitPrice)}
                </p>
                {isDynamic && (
                  <p className={styles.hedgeText}>
                    Ancla dinámica: {formatCompactPrice(upside?.dynamicAnchorPrice || upside?.entryPrice || protection.rangeUpperPrice)}
                  </p>
                )}
              </div>
              <div className={styles.hedgeSide}>
                <ProtectionStatus hedge={upside} />
                {upside?.id && <span className={styles.hedgeId}>#{upside.id}</span>}
              </div>
            </div>
          </div>}

          {isDeltaNeutral && (
            <div className={styles.hedges}>
              <div className={styles.hedgeRow}>
                <div>
                  <span className={styles.hedgeRoleDown}>Overlay delta-neutral</span>
                  <p className={styles.hedgeText}>
                    Objetivo short: {strategyState?.lastTargetQty != null ? `${formatNumber(strategyState.lastTargetQty, 6)} ${protection.inferredAsset}` : '—'}
                  </p>
                  <p className={styles.hedgeText}>
                    Short real: {strategyState?.lastActualQty != null ? `${formatNumber(strategyState.lastActualQty, 6)} ${protection.inferredAsset}` : '—'}
                  </p>
                  <p className={styles.hedgeText}>
                    Ult. motivo: {strategyState?.lastRebalanceReason || 'sin rebalance'}
                  </p>
                </div>
                <div className={styles.hedgeSide}>
                  <span className={styles.hedgeStatus} style={{ color: '#66e1db' }}>● {strategyState?.status || 'healthy'}</span>
                </div>
              </div>

              <div className={styles.hedgeRow}>
                <div>
                  <span className={styles.hedgeRoleUp}>P&L cobertura</span>
                  <p className={styles.hedgeText}>LP: {formatSignedUsd(strategyState?.lpPnlUsd)}</p>
                  <p className={styles.hedgeText}>Hedge unrealized: {formatSignedUsd(strategyState?.hedgeUnrealizedPnlUsd)}</p>
                  <p className={styles.hedgeText}>Hedge realized: {formatSignedUsd(strategyState?.hedgeRealizedPnlUsd)}</p>
                  <p className={styles.hedgeText}>Fees + slippage: {formatSignedUsd(-((Number(strategyState?.executionFeesUsd || 0)) + Number(strategyState?.slippageUsd || 0)))}</p>
                </div>
                <div className={styles.hedgeSide}>
                  <span className={`${styles.hedgeStatus} ${netTone}`}>Neto {formatSignedUsd(strategyState?.netProtectionPnlUsd)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </details>
    </article>
  );
}
