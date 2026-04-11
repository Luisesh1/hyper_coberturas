import { formatAccountIdentity } from '../../../utils/hyperliquidAccounts';
import { STATUS_LABEL } from '../../../components/HedgePanel/constants';
import { getPoolStatus } from '../utils/pool-helpers';
import { formatDuration, formatNumber } from '../../../utils/formatters';
import {
  formatUsd, formatSignedUsd, formatPercent, formatPercentRatio,
  formatCompactPrice, formatRelativeTimestamp, getValuationAccuracyBadge,
  getValuationSourceLabel, shortAddress,
} from '../utils/pool-formatters';
import { computePoolPermissions } from '../utils/pool-permissions';
import RangeTrack from './RangeTrack';
import styles from './ProtectedPoolCard.module.css';

function ProtectionStatus({ hedge }) {
  if (!hedge) return <span className={styles.hedgeEmpty}>Pendiente de crear</span>;
  const statusInfo = STATUS_LABEL[hedge.status] || { text: hedge.status, color: '#94a3b8' };
  return <span className={styles.hedgeStatus} style={{ color: statusInfo.color }}>● {statusInfo.text}</span>;
}

function MetaChip({ label, value, valueClass }) {
  return (
    <div className={styles.metaChip}>
      <span className={styles.metaChipLabel}>{label}</span>
      <strong className={`${styles.metaChipValue} ${valueClass || ''}`}>{value}</strong>
    </div>
  );
}

export default function ProtectedPoolCard({ protection, isDeactivating, onDeactivate, walletState, onClaimFees }) {
  const snapshot = protection.poolSnapshot || {};
  const pairLabel = snapshot.token0?.symbol && snapshot.token1?.symbol
    ? `${snapshot.token0.symbol} / ${snapshot.token1.symbol}`
    : `${protection.token0Symbol} / ${protection.token1Symbol}`;
  const lpPnlValue = Number(snapshot.pnlTotalUsd);
  const downside = protection.hedges?.downside;
  const upside = protection.hedges?.upside;
  // P&L combinada: LP + protección (hedges o delta-neutral overlay)
  const isDeltaNeutralForPnl = protection.protectionMode === 'delta_neutral';
  const strategyStateForPnl = protection.strategyState || null;
  let protectionPnlContribution = 0;
  let hasProtectionPnl = false;
  if (isDeltaNeutralForPnl && strategyStateForPnl) {
    // netProtectionPnlUsd ya incluye lpPnl + hedge components
    const net = Number(strategyStateForPnl.netProtectionPnlUsd);
    if (Number.isFinite(net) && Number.isFinite(lpPnlValue)) {
      protectionPnlContribution = net - lpPnlValue;
      hasProtectionPnl = true;
    }
  } else {
    for (const hedge of [downside, upside]) {
      if (!hedge) continue;
      const unrealized = Number(hedge.unrealizedPnlUsd);
      const funding = Number(hedge.fundingAccumUsd);
      const fee = Number(hedge.entryFeePaidUsd);
      if (Number.isFinite(unrealized)) { protectionPnlContribution += unrealized; hasProtectionPnl = true; }
      if (Number.isFinite(funding)) { protectionPnlContribution += funding; hasProtectionPnl = true; }
      if (Number.isFinite(fee)) { protectionPnlContribution -= fee; hasProtectionPnl = true; }
    }
  }
  const totalPnlValue = Number.isFinite(lpPnlValue)
    ? lpPnlValue + protectionPnlContribution
    : (hasProtectionPnl ? protectionPnlContribution : NaN);
  const initialValueForYield = Number(snapshot.initialValueUsd);
  const totalYieldValue = Number.isFinite(totalPnlValue) && Number.isFinite(initialValueForYield) && initialValueForYield > 0
    ? (totalPnlValue / initialValueForYield) * 100
    : Number(snapshot.yieldPct);
  const pnlValue = totalPnlValue;
  const yieldValue = totalYieldValue;
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
  const netProtPnl = Number(strategyState?.netProtectionPnlUsd);
  const netTone = Number.isFinite(netProtPnl)
    ? (netProtPnl > 0 ? styles.positive : netProtPnl < 0 ? styles.negative : '')
    : '';
  const topUpCap = strategyState?.topUpCapUsd ?? Math.max(300, 0.25 * Number(protection.initialConfiguredHedgeNotionalUsd || protection.configuredHedgeNotionalUsd || 0));
  const timeInRangePct = protection.timeInRangePct != null
    ? Number(protection.timeInRangePct)
    : snapshot.timeInRangePct != null
      ? Number(snapshot.timeInRangePct)
      : null;
  const unclaimedFees = Number(snapshot.unclaimedFeesUsd);
  const initialValueLabel = getValuationAccuracyBadge(snapshot.initialValueUsdAccuracy);
  const initialValueSource = getValuationSourceLabel(snapshot.initialValueUsdSource);
  const openPriceLabel = getValuationAccuracyBadge(snapshot.priceAtOpenAccuracy);
  const openPriceSource = getValuationSourceLabel(snapshot.priceAtOpenSource);

  const { canClaim, canManage, manageTitle, hasUnsupportedV4Hooks } = computePoolPermissions({
    walletState,
    ownerAddress: protection.walletAddress,
    chainId: snapshot.chainId,
    version: protection.version,
    hooks: snapshot.hooks,
    unclaimedFees,
  });

  const modeLabel = isDeltaNeutral ? 'Delta Neutral' : isDynamic ? 'Dinámica' : 'Estática';
  const modeBadgeCls = isDeltaNeutral ? styles.badgeDeltaNeutral : isDynamic ? styles.badgeDynamic : styles.badgeNeutral;

  const poolPayload = { ...snapshot, network: protection.network, version: protection.version, identifier: protection.positionIdentifier, chainId: snapshot.chainId };
  const lpActionButtons = [
    { action: 'increase-liquidity', label: 'Liquidez', icon: '➕', title: 'Agregar liquidez' },
    { action: 'decrease-liquidity', label: 'Liquidez', icon: '➖', title: 'Retirar liquidez' },
    { action: 'reinvest-fees', label: 'Reinvertir', icon: '↻', title: 'Reinvertir fees en liquidez' },
    { action: 'modify-range', label: 'Rango', icon: '↔', title: 'Cambiar rango de precios' },
    { action: 'rebalance', label: 'Rebalancear', icon: '⚖', title: 'Rebalancear activos' },
    { action: 'close-to-usdc', label: 'Cerrar a USDC', icon: '💵', title: 'Cerrar la posición y convertir los fondos a USDC' },
    { action: 'close-keep-assets', label: 'Cerrar LP', icon: '📦', title: 'Cerrar la posición y conservar token0/token1 en la wallet' },
  ];

  return (
    <article className={`${styles.card} ${toneCls}`}>
      {/* ─── Cabecera ───────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h3 className={styles.pair}>{pairLabel}</h3>
          <div className={styles.badges}>
            <span className={styles.badgeVersion}>{protection.version.toUpperCase()}</span>
            <span className={styles.badgeNetwork}>{snapshot.networkLabel || protection.network}</span>
            {hasUnsupportedV4Hooks && <span className={styles.badgeNeutral}>Hooks no soportados</span>}
            <span className={modeBadgeCls}>{modeLabel}</span>
            <span className={protection.status === 'active' ? styles.badgeProtected : styles.badgeInactive}>
              {protection.status === 'active' ? '● Activa' : '○ Inactiva'}
            </span>
          </div>
        </div>
        <div className={styles.actions}>
          <span className={styles.refreshMeta} title="Última actualización de datos">
            Act. {formatRelativeTimestamp(protection.updatedAt)}
          </span>
          {protection.status === 'active' && (
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => onDeactivate(protection)}
              disabled={isDeactivating}
              title="Desactivar la protección y cancelar las coberturas asociadas"
            >
              {isDeactivating ? '⏳ Desactivando...' : 'Desactivar protección'}
            </button>
          )}
        </div>
      </div>

      {/* ─── Estado del rango ──────────────────── */}
      <div className={styles.statusLine}>
        <span className={`${styles.statusDot} ${styles[`dot_${status.tone}`]}`} />
        <span className={styles.statusText}>{status.label}</span>
        {protection.walletAddress && (
          <span className={styles.walletAddress} title={protection.walletAddress}>
            {shortAddress(protection.walletAddress)}
          </span>
        )}
      </div>

      {/* ─── Métricas principales ──────────────── */}
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValueRow}>
            <span className={styles.metricValue}>{formatUsd(snapshot.initialValueUsd)}</span>
            {initialValueLabel && snapshot.initialValueUsd != null && (
              <span className={styles.metricBadge}>{initialValueLabel}</span>
            )}
          </span>
          <span className={styles.metricLabel}>Valor inicial LP</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatUsd(snapshot.currentValueUsd)}</span>
          <span className={styles.metricLabel}>Valor actual LP</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${unclaimedFees > 0 ? styles.amber : ''}`}>{formatUsd(snapshot.unclaimedFeesUsd)}</span>
          <span className={styles.metricLabel}>Fees acumuladas</span>
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${pnlTone}`}>
            {formatSignedUsd(Number.isFinite(totalPnlValue) ? totalPnlValue : null)}
          </span>
          <span className={styles.metricLabel}>
            Ganancia / Pérdida{hasProtectionPnl ? ' (LP + protección)' : ''}
          </span>
          {hasProtectionPnl && Number.isFinite(lpPnlValue) && (
            <span className={styles.metricSubValue} title="Desglose">
              LP: {formatSignedUsd(lpPnlValue)} · Prot: {formatSignedUsd(protectionPnlContribution)}
            </span>
          )}
        </div>
        <div className={styles.metric}>
          <span className={`${styles.metricValue} ${yieldTone}`}>
            {formatPercent(Number.isFinite(totalYieldValue) ? totalYieldValue : null)}
          </span>
          <span className={styles.metricLabel}>Rendimiento</span>
        </div>
        {snapshot.activeForMs != null && (
          <div className={styles.metric}>
            <span className={styles.metricValue}>{formatDuration(snapshot.activeForMs)}</span>
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

      {/* ─── Visualización del rango ───────────── */}
      {snapshot.mode === 'lp_position' && <RangeTrack pool={snapshot} compact />}

      {/* ─── Acciones LP ───────────────────────── */}
      {['v3', 'v4'].includes(protection.version) && onClaimFees && (
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
            onClick={() => onClaimFees('collect-fees', poolPayload)}
            title={
              !walletState?.isConnected ? 'Conecta tu wallet para cobrar fees'
                : walletState.chainId !== snapshot.chainId ? 'Cambia a la red correcta en tu wallet'
                  : protection.walletAddress?.toLowerCase() !== walletState.address?.toLowerCase() ? 'Esta wallet no es dueña de la posición'
                    : unclaimedFees <= 0 ? 'No hay fees acumuladas por cobrar'
                      : `Cobrar ${formatUsd(snapshot.unclaimedFeesUsd)} en fees`
            }
          >
            <span>💰 Cobrar fees</span>
            {unclaimedFees > 0 && <span className={styles.claimAmount}>{formatUsd(snapshot.unclaimedFeesUsd)}</span>}
          </button>
          <div className={styles.manageRow}>
            {lpActionButtons.map((item) => (
              <button
                key={item.action}
                type="button"
                className={styles.secondaryBtn}
                disabled={!canManage}
                onClick={() => onClaimFees(item.action, poolPayload)}
                title={canManage ? item.title : manageTitle}
              >
                <span className={styles.secondaryBtnIcon} aria-hidden="true">{item.icon}</span>
                <span className={styles.secondaryBtnLabel}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Sección expandible: configuración y coberturas ── */}
      <details className={styles.details}>
        <summary className={styles.detailsToggle}>
          <span>Ver configuración y coberturas activas</span>
          <span className={styles.detailsChevron}>›</span>
        </summary>
        <div className={styles.detailsContent}>

          <p className={styles.sectionTitle}>Datos del LP protegido</p>
          <div className={styles.metaGrid}>
            <MetaChip label="Precio de apertura" value={`${formatCompactPrice(snapshot.priceAtOpen)}${openPriceLabel ? ` · ${openPriceLabel}` : ''}`} />
            <MetaChip label="Origen precio apertura" value={openPriceSource} />
            <MetaChip label="Origen valor inicial" value={initialValueSource} />
            <MetaChip label="Valor actual LP" value={formatUsd(snapshot.currentValueUsd)} />
          </div>

          {snapshot.mode === 'lp_position' && <RangeTrack pool={snapshot} />}

          {Array.isArray(snapshot.valuationWarnings) && snapshot.valuationWarnings.length > 0 && (
            <>
              <p className={styles.sectionTitle}>Notas de valuación</p>
              <div className={styles.warningList}>
                {snapshot.valuationWarnings.map((warning) => (
                  <p key={warning} className={styles.warningItem}>{warning}</p>
                ))}
              </div>
            </>
          )}

          {/* Cuenta HL usada para la protección */}
          {protection.account && (
            <div className={styles.hlAccountRow}>
              <span className={styles.hlAccountIcon}>🔒</span>
              <span className={styles.hlAccountLabel}>Cuenta HL:</span>
              <span className={styles.hlAccountValue}>{formatAccountIdentity(protection.account)}</span>
              {protection.account.isDefault && (
                <span className={styles.hlAccountDefault}>predeterminada</span>
              )}
            </div>
          )}

          {/* Parámetros de configuración */}
          <p className={styles.sectionTitle}>Parámetros de la protección</p>
          <div className={styles.metaGrid}>
            <MetaChip label="Activo cubierto en HL" value={protection.inferredAsset} />
            <MetaChip label="Notional protegido" value={formatUsd(protection.configuredHedgeNotionalUsd)} />
            <MetaChip label="Apalancamiento" value={`${protection.leverage}x ${protection.marginMode}`} />
            {!isDeltaNeutral && (
              <MetaChip
                label="Diferencia stop-loss"
                value={formatPercentRatio(protection.stopLossDifferencePct)}
              />
            )}
            {protection.valueMultiplier && (
              <MetaChip
                label="Multiplicador de valor LP"
                value={`${protection.valueMultiplier}x el LP`}
              />
            )}

            {/* Parámetros modo dinámico */}
            {isDynamic && <>
              <MetaChip label="Fase actual" value={dynamicState?.phase || 'neutral'} />
              <MetaChip
                label="Distancia mín. confirmación breakout"
                value={protection.breakoutConfirmDistancePct != null ? `${protection.breakoutConfirmDistancePct}%` : '0.5%'}
              />
              <MetaChip
                label="Duración mín. confirmación breakout"
                value={protection.breakoutConfirmDurationSec != null ? formatDuration(protection.breakoutConfirmDurationSec * 1000) : '10 min'}
              />
              <MetaChip label="Último borde roto" value={dynamicState?.lastBrokenEdge || '—'} />
              <MetaChip label="Precio de reentrada activo" value={formatCompactPrice(dynamicState?.currentReentryPrice)} />
              <MetaChip label="Breakout pendiente" value={dynamicState?.pendingBreakoutEdge || '—'} />
              <MetaChip label="Estado de recuperación" value={dynamicState?.recoveryStatus || 'OK'} />
            </>}

            {/* Parámetros delta-neutral */}
            {isDeltaNeutral && <>
              <MetaChip label="Estado de la cobertura" value={strategyState?.status || 'healthy'} />
              <MetaChip label="Delta efectivo del LP" value={strategyState?.lastDeltaQty != null ? formatNumber(strategyState.lastDeltaQty, 6) : '—'} />
              <MetaChip label="Gamma del LP" value={strategyState?.lastGamma != null ? formatNumber(strategyState.lastGamma, 8) : '—'} />
              <MetaChip label="Banda de rebalance efectiva" value={strategyState?.effectiveBandPct != null ? `${formatNumber(strategyState.effectiveBandPct, 2)}%` : '—'} />
              <MetaChip
                label="Volatilidad realizada (4h / 24h)"
                value={strategyState?.rv4hPct != null ? `${formatNumber(strategyState.rv4hPct, 1)}% / ${formatNumber(strategyState.rv24hPct, 1)}%` : '—'}
              />
              <MetaChip label="Funding acumulado" value={formatSignedUsd(strategyState?.fundingAccumUsd)} />
              <MetaChip label="Distancia a liquidación" value={strategyState?.distanceToLiqPct != null ? `${formatNumber(strategyState.distanceToLiqPct, 2)}%` : '—'} />
              <MetaChip label="P&L neto de cobertura" value={formatSignedUsd(strategyState?.netProtectionPnlUsd)} valueClass={netTone} />
              <MetaChip label="Capital recargado hoy" value={`${formatUsd(strategyState?.topUpUsd24h)} / ${formatUsd(topUpCap)}`} />
              <MetaChip label="Recargas automáticas realizadas hoy" value={`${strategyState?.topUpCount24h || 0} de 3`} />
            </>}
          </div>

          {/* Coberturas activas — modo estático / dinámico */}
          {!isDeltaNeutral && (
            <>
              <p className={styles.sectionTitle}>Coberturas del rango</p>
              <div className={styles.hedges}>
                <div className={styles.hedgeRow}>
                  <div className={styles.hedgeInfo}>
                    <span className={styles.hedgeRoleDown}>▼ Cobertura bajista (SHORT)</span>
                    <p className={styles.hedgeText}>
                      Entra en <strong>{formatCompactPrice(downside?.entryPrice || protection.rangeLowerPrice)}</strong>
                      {' · '}Stop-loss en <strong>{formatCompactPrice(downside?.exitPrice)}</strong>
                    </p>
                    {isDynamic && downside && (
                      <p className={styles.hedgeTextMuted}>
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
                  <div className={styles.hedgeInfo}>
                    <span className={styles.hedgeRoleUp}>▲ Cobertura alcista (LONG)</span>
                    <p className={styles.hedgeText}>
                      Entra en <strong>{formatCompactPrice(upside?.entryPrice || protection.rangeUpperPrice)}</strong>
                      {' · '}Stop-loss en <strong>{formatCompactPrice(upside?.exitPrice)}</strong>
                    </p>
                    {isDynamic && upside && (
                      <p className={styles.hedgeTextMuted}>
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
            </>
          )}

          {/* Overlay delta-neutral */}
          {isDeltaNeutral && (
            <>
              <p className={styles.sectionTitle}>Overlay delta-neutral</p>
              <div className={styles.hedges}>
                <div className={styles.hedgeRow}>
                  <div className={styles.hedgeInfo}>
                    <span className={styles.hedgeRoleDown}>⇄ Posición SHORT en Hyperliquid</span>
                    <p className={styles.hedgeText}>
                      Objetivo: <strong>{strategyState?.lastTargetQty != null ? `${formatNumber(strategyState.lastTargetQty, 6)} ${protection.inferredAsset}` : '—'}</strong>
                      {' · '}Real: <strong>{strategyState?.lastActualQty != null ? `${formatNumber(strategyState.lastActualQty, 6)} ${protection.inferredAsset}` : '—'}</strong>
                    </p>
                    <p className={styles.hedgeTextMuted}>
                      Último rebalance: {strategyState?.lastRebalanceReason || 'sin rebalance aún'}
                    </p>
                  </div>
                  <div className={styles.hedgeSide}>
                    <span className={styles.hedgeStatus} style={{ color: '#66e1db' }}>● {strategyState?.status || 'healthy'}</span>
                  </div>
                </div>

                <div className={styles.hedgeRow}>
                  <div className={styles.hedgeInfo}>
                    <span className={styles.hedgeRoleUp}>📊 Desglose de P&L</span>
                    <p className={styles.hedgeText}>LP: <strong className={Number(strategyState?.lpPnlUsd) >= 0 ? styles.positive : styles.negative}>{formatSignedUsd(strategyState?.lpPnlUsd)}</strong></p>
                    <p className={styles.hedgeText}>Hedge no realizado: <strong>{formatSignedUsd(strategyState?.hedgeUnrealizedPnlUsd)}</strong></p>
                    <p className={styles.hedgeText}>Hedge realizado: <strong>{formatSignedUsd(strategyState?.hedgeRealizedPnlUsd)}</strong></p>
                    <p className={styles.hedgeText}>Costes (fees + slippage): <strong className={styles.negative}>{formatSignedUsd(-((Number(strategyState?.executionFeesUsd || 0)) + Number(strategyState?.slippageUsd || 0)))}</strong></p>
                  </div>
                  <div className={styles.hedgeSide}>
                    <span className={`${styles.hedgeStatus} ${netTone}`}>
                      Neto {formatSignedUsd(strategyState?.netProtectionPnlUsd)}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </details>
    </article>
  );
}
