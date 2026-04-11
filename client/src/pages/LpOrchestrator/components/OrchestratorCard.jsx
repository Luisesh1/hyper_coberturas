import { useMemo, useState } from 'react';
import OrchestratorRangeBar from './OrchestratorRangeBar';
import AccountingPanel from './AccountingPanel';
import ProtectionOpsPanel from './ProtectionOpsPanel';
import { formatUsd, formatRelativeTimestamp } from '../../UniswapPools/utils/pool-formatters';
import styles from './OrchestratorCard.module.css';

const PHASE_LABELS = {
  idle: { label: 'Sin LP activo', tone: 'muted' },
  lp_active: { label: 'En zona central', tone: 'ok' },
  evaluating: { label: 'Evaluando', tone: 'info' },
  needs_rebalance: { label: 'Rebalanceo recomendado', tone: 'warn' },
  urgent_adjust: { label: 'AJUSTE URGENTE', tone: 'urgent' },
  executing: { label: 'Ejecutando', tone: 'info' },
  verifying: { label: 'Verificando', tone: 'info' },
  failed: { label: 'Error — revisión humana', tone: 'urgent' },
  complete: { label: 'Completado', tone: 'muted' },
};

function buildPoolFromOrchestrator(orch) {
  const pool = orch.lastEvaluation?.poolSnapshot;
  if (!pool) return null;
  return {
    ...pool,
    token0: pool.token0 || { symbol: orch.token0Symbol },
    token1: pool.token1 || { symbol: orch.token1Symbol },
    network: pool.network || orch.network,
    version: pool.version || orch.version,
    identifier: pool.identifier || orch.activePositionIdentifier,
    positionIdentifier: pool.positionIdentifier || orch.activePositionIdentifier,
  };
}

function formatFeeTier(feeTier) {
  const n = Number(feeTier);
  if (!Number.isFinite(n) || n <= 0) return '';
  const pct = n / 10_000;
  const formatted = pct < 0.1 ? pct.toFixed(2) : pct.toFixed(2).replace(/\.?0+$/, '');
  return `${formatted}%`;
}

function formatPriceDelta(currentPrice, openPrice) {
  const c = Number(currentPrice);
  const o = Number(openPrice);
  if (!Number.isFinite(c) || !Number.isFinite(o) || o <= 0) return null;
  const delta = ((c - o) / o) * 100;
  if (Math.abs(delta) < 0.005) return { text: '0.00%', tone: 'neutral' };
  const sign = delta > 0 ? '+' : '';
  return {
    text: `${sign}${delta.toFixed(2)}%`,
    tone: delta > 0 ? 'positive' : 'negative',
  };
}

export default function OrchestratorCard({
  orchestrator,
  isEvaluating,
  walletConnected,
  onEvaluate,
  onAction,
  onKill,
  onKillAndArchive,
  onArchive,
  onCreateNewLp,
  onAdoptLp,
  onShowLog,
}) {
  const phaseInfo = PHASE_LABELS[orchestrator.phase] || { label: orchestrator.phase, tone: 'muted' };
  const evaluation = orchestrator.lastEvaluation?.evaluation;
  const costEstimate = orchestrator.lastEvaluation?.costEstimate;
  const netEarnings = orchestrator.lastEvaluation?.netEarnings;
  const recommendCollect = orchestrator.lastEvaluation?.recommendCollect;
  const pool = useMemo(() => buildPoolFromOrchestrator(orchestrator), [orchestrator]);
  const hasActiveLp = !!orchestrator.activePositionIdentifier;
  const [showStrategy, setShowStrategy] = useState(false);

  const priceDelta = useMemo(() => (
    pool ? formatPriceDelta(pool.priceCurrent, pool.priceAtOpen) : null
  ), [pool]);

  const banner = useMemo(() => {
    if (orchestrator.phase === 'urgent_adjust') {
      return {
        tone: 'urgent',
        title: '🚨 Precio fuera de rango — ajustar AHORA',
        body: evaluation?.outOfRangeSide === 'below'
          ? 'Precio por debajo del rango.'
          : 'Precio por encima del rango.',
      };
    }
    if (orchestrator.phase === 'needs_rebalance') {
      return {
        tone: 'warn',
        title: '⚠ Rebalanceo recomendado',
        body: costEstimate && netEarnings
          ? `Coste estimado ${formatUsd(costEstimate.totalCostUsd)} vs ganancias netas ${formatUsd(netEarnings)} (ratio ${(costEstimate.totalCostUsd / Math.max(netEarnings, 1e-9)).toFixed(2)}).`
          : null,
      };
    }
    if (orchestrator.phase === 'failed') {
      return {
        tone: 'urgent',
        title: '❌ Error en última verificación',
        body: orchestrator.lastError || 'El estado on-chain no coincide con lo esperado. Revisa la bitácora.',
      };
    }
    if (recommendCollect) {
      return {
        tone: 'info',
        title: '💰 Fees listas para cobrar',
        body: `Fees acumuladas: ${formatUsd(orchestrator.lastEvaluation?.unclaimedFeesUsd)}.`,
      };
    }
    return null;
  }, [orchestrator, evaluation, costEstimate, netEarnings, recommendCollect]);

  // Construye lista priorizada de acciones según el estado actual del orquestador.
  // El "primary" se renderiza primero y con tono destacado; el resto va detrás.
  const lpActions = useMemo(() => {
    const baseActions = [
      { id: 'modify-range', label: 'Ajustar rango', icon: '🎯' },
      { id: 'rebalance', label: 'Rebalancear', icon: '⚖' },
      { id: 'collect-fees', label: 'Cobrar fees', icon: '💰' },
      { id: 'reinvest-fees', label: 'Reinvertir fees', icon: '♻' },
      { id: 'increase-liquidity', label: 'Agregar liquidez', icon: '➕' },
      { id: 'decrease-liquidity', label: 'Reducir liquidez', icon: '➖' },
    ];
    const ordered = [...baseActions];
    let primaryId = null;
    let primaryTone = null;
    if (orchestrator.phase === 'urgent_adjust') {
      primaryId = 'modify-range'; primaryTone = 'urgent';
    } else if (orchestrator.phase === 'needs_rebalance') {
      primaryId = 'modify-range'; primaryTone = 'warn';
    } else if (recommendCollect) {
      primaryId = 'collect-fees'; primaryTone = 'info';
    }
    if (primaryId) {
      const idx = ordered.findIndex((a) => a.id === primaryId);
      if (idx > 0) {
        const [primary] = ordered.splice(idx, 1);
        ordered.unshift({ ...primary, primary: true, tone: primaryTone });
      } else if (idx === 0) {
        ordered[0] = { ...ordered[0], primary: true, tone: primaryTone };
      }
    }
    return ordered;
  }, [orchestrator.phase, recommendCollect]);

  const strategyConfig = orchestrator.strategyConfig || {};

  return (
    <article className={`${styles.card} ${styles[phaseInfo.tone]}`}>
      <header className={styles.header}>
        <div className={styles.headerInfo}>
          <h3 className={styles.name}>{orchestrator.name}</h3>
          <span className={styles.subtitle}>
            <strong className={styles.pair}>{orchestrator.token0Symbol}/{orchestrator.token1Symbol}</strong>
            <span className={styles.dot}>·</span>
            {orchestrator.network} · {orchestrator.version}
            {orchestrator.feeTier != null && (
              <>
                <span className={styles.dot}>·</span>
                {formatFeeTier(orchestrator.feeTier)}
              </>
            )}
          </span>
        </div>
        <span className={`${styles.badge} ${styles[`badge_${phaseInfo.tone}`]}`}>
          {phaseInfo.label}
        </span>
      </header>

      {banner && (
        <div className={`${styles.banner} ${styles[`banner_${banner.tone}`]}`}>
          <strong>{banner.title}</strong>
          {banner.body && <span>{banner.body}</span>}
        </div>
      )}

      {hasActiveLp ? (
        pool && (
          <>
            <OrchestratorRangeBar
              pool={pool}
              edgeMarginPct={Number(strategyConfig.edgeMarginPct) || 40}
              activeForMs={pool.activeForMs ?? null}
              timeInRangePct={orchestrator.lastEvaluation?.timeInRangePct ?? null}
            />
            {priceDelta && (
              <div className={styles.priceDeltaRow}>
                <span className={styles.priceDeltaLabel}>vs apertura</span>
                <span className={`${styles.priceDeltaValue} ${styles[`delta_${priceDelta.tone}`]}`}>
                  {priceDelta.text}
                </span>
              </div>
            )}
          </>
        )
      ) : (
        <div className={styles.idleState}>
          <span className={styles.idleIcon}>🌱</span>
          <div className={styles.idleText}>
            <strong>Sin LP activo</strong>
            <span>Crea el primer LP para que el orquestador empiece a evaluarlo cada 30 s.</span>
          </div>
        </div>
      )}

      <AccountingPanel
        accounting={orchestrator.accounting}
        createdAt={orchestrator.createdAt}
        initialTotalUsd={orchestrator.initialTotalUsd}
        unclaimedFeesUsd={
          orchestrator.lastEvaluation?.unclaimedFeesUsd
          ?? orchestrator.lastEvaluation?.poolSnapshot?.unclaimedFeesUsd
          ?? null
        }
      />

      <ProtectionOpsPanel
        orchestratorId={orchestrator.id}
        hasProtection={!!orchestrator.activeProtectedPoolId}
      />

      <details
        className={styles.strategyBlock}
        open={showStrategy}
        onToggle={(e) => setShowStrategy(e.currentTarget.open)}
      >
        <summary className={styles.strategySummary}>
          <span>⚙ Estrategia</span>
          <span className={styles.strategyHint}>
            ±{strategyConfig.rangeWidthPct ?? '?'}% · borde {strategyConfig.edgeMarginPct ?? '?'}%
          </span>
        </summary>
        <div className={styles.strategyGrid}>
          <StrategyCell label="Ancho rango" value={`±${strategyConfig.rangeWidthPct ?? '?'}%`} />
          <StrategyCell label="Margen borde" value={`${strategyConfig.edgeMarginPct ?? '?'}%`} />
          <StrategyCell
            label="Banda central"
            value={strategyConfig.edgeMarginPct != null
              ? `${(100 - 2 * Number(strategyConfig.edgeMarginPct)).toFixed(0)}%`
              : '?'}
          />
          <StrategyCell label="Coste/recompensa" value={strategyConfig.costToRewardThreshold ?? '?'} />
          <StrategyCell label="Reinvest umbral" value={`$${strategyConfig.reinvestThresholdUsd ?? 0}`} />
          <StrategyCell label="Alerta repite" value={`${strategyConfig.urgentAlertRepeatMinutes ?? 30}m`} />
        </div>
      </details>

      <div className={styles.meta}>
        <span className={styles.metaInfo}>
          <span className={styles.evalDot} />
          Última evaluación: {formatRelativeTimestamp(orchestrator.lastEvaluationAt)}
        </span>
        <div className={styles.metaActions}>
          <button
            type="button"
            className={styles.metaBtn}
            onClick={() => onShowLog?.(orchestrator)}
            title="Ver bitácora de decisiones"
          >
            📋 Bitácora
          </button>
          <button
            type="button"
            className={`${styles.metaBtn} ${isEvaluating ? styles.metaBtnBusy : ''}`}
            onClick={() => onEvaluate(orchestrator)}
            disabled={isEvaluating}
            title="Forzar evaluación inmediata"
          >
            {isEvaluating ? '⟳ Evaluando…' : '⟳ Refrescar'}
          </button>
        </div>
      </div>

      <div className={styles.actions}>
        {hasActiveLp ? (
          <>
            {lpActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={`${styles.actionBtn} ${action.primary ? styles.actionPrimary : ''} ${action.tone ? styles[`action_${action.tone}`] : ''}`}
                onClick={() => onAction(action.id, orchestrator, pool)}
                disabled={!walletConnected}
                title={!walletConnected ? 'Conecta una wallet para firmar' : ''}
              >
                <span className={styles.actionIcon}>{action.icon}</span>
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.killBtn}`}
              onClick={() => onKill(orchestrator)}
              disabled={!walletConnected}
              title="Cierra el LP activo. La contabilidad del orquestador se conserva."
            >
              <span className={styles.actionIcon}>🔪</span>
              Matar LP
            </button>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.killArchiveBtn}`}
              onClick={() => onKillAndArchive?.(orchestrator)}
              disabled={!walletConnected || !onKillAndArchive}
              title="Cierra el LP conservando los tokens (sin convertir a stable) y archiva el orquestador. Irreversible."
            >
              <span className={styles.actionIcon}>💀</span>
              Cerrar y archivar
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.actionPrimary}`}
              onClick={() => onCreateNewLp(orchestrator)}
              disabled={!walletConnected}
            >
              <span className={styles.actionIcon}>＋</span>
              Crear nuevo LP
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => onAdoptLp?.(orchestrator)}
              disabled={!walletConnected || !onAdoptLp}
              title="Vincula un LP que ya existe en tu wallet (mismo par y red) al orquestador. Útil cuando un LP recién creado no quedó vinculado por un error transitorio."
            >
              <span className={styles.actionIcon}>🔗</span>
              Adoptar LP existente
            </button>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.archiveBtn}`}
              onClick={() => onArchive(orchestrator)}
              title="Archiva el orquestador. Solo si no hay LP activo."
            >
              <span className={styles.actionIcon}>📦</span>
              Archivar
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function StrategyCell({ label, value }) {
  return (
    <div className={styles.strategyCell}>
      <span className={styles.strategyCellLabel}>{label}</span>
      <span className={styles.strategyCellValue}>{value}</span>
    </div>
  );
}
