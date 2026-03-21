import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { STATUS_LABEL } from '../../../components/HedgePanel/constants';
import { getPoolStatus } from '../utils/pool-helpers';
import { formatDuration } from '../../../utils/formatters';
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
  const dynamicState = protection.dynamicState || null;

  return (
    <article className={`${styles.card} ${toneCls}`}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.pair}>{pairLabel}</h3>
          <div className={styles.badges}>
            <span className={styles.badgeVersion}>{protection.version.toUpperCase()}</span>
            <span className={styles.badgeNetwork}>{snapshot.networkLabel || protection.network}</span>
            {isDynamic && <span className={styles.badgeDynamic}>Dinámica</span>}
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
            <div className={styles.metaChip}><span>SL diff</span><strong>{formatPercentRatio(protection.stopLossDifferencePct)}</strong></div>
            {isDynamic && <div className={styles.metaChip}><span>Fase dinámica</span><strong>{dynamicState?.phase || 'neutral'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Dist. breakout</span><strong>{protection.breakoutConfirmDistancePct != null ? `${protection.breakoutConfirmDistancePct}%` : '0.5%'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Tiempo breakout</span><strong>{protection.breakoutConfirmDurationSec != null ? formatDuration(protection.breakoutConfirmDurationSec * 1000) : '10m'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Ult. borde</span><strong>{dynamicState?.lastBrokenEdge || '—'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Reentrada</span><strong>{formatCompactPrice(dynamicState?.currentReentryPrice)}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Breakout pendiente</span><strong>{dynamicState?.pendingBreakoutEdge || '—'}</strong></div>}
            {isDynamic && <div className={styles.metaChip}><span>Recovery</span><strong>{dynamicState?.recoveryStatus || 'OK'}</strong></div>}
            <div className={styles.metaChip}>
              <span>Origen</span>
              <strong>{protection.valueMultiplier ? `${protection.valueMultiplier}x LP` : 'Manual / base LP'}</strong>
            </div>
          </div>

          <div className={styles.hedges}>
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
          </div>
        </div>
      </details>
    </article>
  );
}
