import { useMemo, useState } from 'react';
import OrchestratorRangeBar from './OrchestratorRangeBar';
import AccountingPanel from './AccountingPanel';
import ProtectionOpsPanel from './ProtectionOpsPanel';
import OrchestratorWallet from './OrchestratorWallet';
import { formatUsd, formatRelativeTimestamp } from '../../UniswapPools/utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { getOrchestratorIssue } from './orchestratorIssueState';
import { getOrchestratorSeverity } from './orchestratorSeverity';
import { computeAccountingSummary, buildVerdictSentence } from './accountingSummary';
import { getHedgePolicyBadge } from './hedgePolicyBadge';
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

function formatSignedUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${formatUsd(Math.abs(n))}`;
}

function formatSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}%`;
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
  onShowIssue,
  onEditConfig,
}) {
  const phaseInfo = PHASE_LABELS[orchestrator.phase] || { label: orchestrator.phase, tone: 'muted' };
  const costEstimate = orchestrator.lastEvaluation?.costEstimate;
  const netEarnings = orchestrator.lastEvaluation?.netEarnings;
  const recommendCollect = orchestrator.lastEvaluation?.recommendCollect;
  const pool = useMemo(() => buildPoolFromOrchestrator(orchestrator), [orchestrator]);
  const hasActiveLp = !!orchestrator.activePositionIdentifier;
  const [showStrategy, setShowStrategy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const priceDelta = useMemo(() => (
    pool ? formatPriceDelta(pool.priceCurrent, pool.priceAtOpen) : null
  ), [pool]);

  const issue = useMemo(() => getOrchestratorIssue(orchestrator), [orchestrator]);

  // Qué motor de cobertura está moviendo el hedge ahora mismo. Va en la línea
  // de identidad porque es lo que ESTE orquestador es, igual que la red o el
  // fee tier — y no en los badges, que son el canal de alarma.
  //
  // Cuando la incidencia ya grita "Sin cobertura" no se repite dos veces en
  // el mismo encabezado: el chip aporta el nombre de la política, y ahí no
  // hay ninguna corriendo que nombrar.
  const hedgeBadge = useMemo(
    () => (issue?.kind === 'unprotected' ? null : getHedgePolicyBadge(orchestrator)),
    [orchestrator, issue],
  );
  const severity = useMemo(() => getOrchestratorSeverity(orchestrator), [orchestrator]);

  const summary = useMemo(
    () => computeAccountingSummary(orchestrator.accounting, orchestrator.initialTotalUsd),
    [orchestrator.accounting, orchestrator.initialTotalUsd],
  );
  const verdictSentence = useMemo(() => buildVerdictSentence(summary), [summary]);
  const netTone = summary.totalNetUsd == null
    ? 'neutral'
    : summary.totalNetUsd >= 0 ? 'positive' : 'negative';

  const timeInRangePct = orchestrator.lastEvaluation?.timeInRangePct ?? null;

  // El banner sólo sobrevive cuando aporta algo que el chip de incidencia no
  // dice ya. Antes la fase, el chip y el banner repetían el mismo mensaje
  // pegados uno debajo del otro.
  const banner = useMemo(() => {
    if (orchestrator.phase === 'failed' && !issue) {
      return {
        tone: 'urgent',
        title: 'Error en última verificación',
        body: orchestrator.lastError || 'El estado on-chain no coincide con lo esperado. Revisa la bitácora.',
      };
    }
    if (orchestrator.phase === 'needs_rebalance' && costEstimate && netEarnings) {
      return {
        tone: 'warn',
        title: 'Rebalanceo recomendado',
        body: `Coste estimado ${formatUsd(costEstimate.totalCostUsd)} vs ganancias netas ${formatUsd(netEarnings)} (ratio ${(costEstimate.totalCostUsd / Math.max(netEarnings, 1e-9)).toFixed(2)}).`,
      };
    }
    if (recommendCollect) {
      return {
        tone: 'info',
        title: 'Fees listas para cobrar',
        body: `Fees acumuladas: ${formatUsd(orchestrator.lastEvaluation?.unclaimedFeesUsd)}.`,
      };
    }
    return null;
  }, [orchestrator, issue, costEstimate, netEarnings, recommendCollect]);

  // Acciones del LP: una primaria a la vista, el resto detrás del menú. Antes
  // las seis competían en la misma fila con las dos destructivas.
  const { primaryAction, secondaryActions } = useMemo(() => {
    const base = [
      { id: 'modify-range', label: 'Ajustar rango' },
      { id: 'rebalance', label: 'Rebalancear' },
      { id: 'collect-fees', label: 'Cobrar fees' },
      { id: 'reinvest-fees', label: 'Reinvertir fees' },
      { id: 'increase-liquidity', label: 'Agregar liquidez' },
      { id: 'decrease-liquidity', label: 'Reducir liquidez' },
    ];
    let primaryId = 'modify-range';
    let tone = null;
    if (orchestrator.phase === 'urgent_adjust') tone = 'urgent';
    else if (orchestrator.phase === 'needs_rebalance') tone = 'warn';
    else if (recommendCollect) { primaryId = 'collect-fees'; tone = 'info'; }

    const idx = base.findIndex((a) => a.id === primaryId);
    const [primary] = base.splice(idx, 1);
    return { primaryAction: { ...primary, tone }, secondaryActions: base };
  }, [orchestrator.phase, recommendCollect]);

  const strategyConfig = orchestrator.strategyConfig || {};
  const runAction = (id) => { setMenuOpen(false); onAction(id, orchestrator, pool); };

  return (
    <article className={`${styles.card} ${styles[`card_${severity}`]}`}>
      {/* Riel de severidad: dice si esta tarjeta pide algo antes de leer nada. */}
      <span className={`${styles.rail} ${styles[`rail_${severity}`]}`} aria-hidden="true" />

      <div className={styles.body}>
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
              {hedgeBadge && (
                <>
                  <span className={styles.dot}>·</span>
                  <span
                    className={`${styles.hedgeChip} ${styles[`hedgeChip_${hedgeBadge.tone}`]}`}
                    title={hedgeBadge.title}
                  >
                    <ShieldIcon className={styles.hedgeChipIcon} />
                    {hedgeBadge.text}
                  </span>
                </>
              )}
            </span>
            <OrchestratorWallet address={orchestrator.walletAddress} />
          </div>
          <div className={styles.headerBadges}>
            {issue ? (
              <button
                type="button"
                className={`${styles.issueChip} ${styles[`issueChip_${issue.tone}`]}`}
                onClick={() => onShowIssue?.(orchestrator)}
                title="Ver detalle del problema del orquestador"
              >
                {issue.chipLabel}
              </button>
            ) : (
              <span className={`${styles.badge} ${styles[`badge_${phaseInfo.tone}`]}`}>
                {phaseInfo.label}
              </span>
            )}
          </div>
        </header>

        {banner && (
          <div className={`${styles.banner} ${styles[`banner_${banner.tone}`]}`}>
            <strong>{banner.title}</strong>
            {banner.body && <span>{banner.body}</span>}
          </div>
        )}

        {hasActiveLp ? (
          pool && (
            <OrchestratorRangeBar
              pool={pool}
              edgeMarginPct={Number(strategyConfig.edgeMarginPct) || 40}
              activeForMs={pool.activeForMs ?? null}
              hedge={orchestrator.activeHedge}
            />
          )
        ) : (
          <div className={styles.idleState}>
            <div className={styles.idleText}>
              <strong>Sin LP activo</strong>
              <span>Crea el primer LP para que el orquestador empiece a evaluarlo cada 30 s.</span>
            </div>
          </div>
        )}

        {/* ── VEREDICTO ── Lo primero que se lee, y lo único grande. */}
        {summary.totalNetUsd != null && (
          <div className={`${styles.verdict} ${styles[`verdict_${netTone}`]}`}>
            <div className={styles.verdictHead}>
              <span className={styles.verdictLabel}>P&amp;L neto</span>
              <div className={styles.verdictValue}>
                <span className={styles.verdictUsd}>{formatSignedUsd(summary.totalNetUsd)}</span>
                {summary.netPct != null && (
                  <span className={styles.verdictPct}>{formatSignedPct(summary.netPct)}</span>
                )}
              </div>
              {orchestrator.initialTotalUsd != null && (
                <span className={styles.verdictBase}>sobre {formatUsd(orchestrator.initialTotalUsd)} de capital</span>
              )}
            </div>
            {verdictSentence && <p className={styles.verdictSentence}>{verdictSentence}</p>}
          </div>
        )}

        {/* Las dos patas, plegadas. El detalle vive detrás del disclosure. */}
        {summary.totalNetUsd != null && (
          <details className={styles.legs}>
            <summary className={styles.legsSummary}>
              <span className={styles.leg}>
                <ChevronIcon className={styles.legChevron} />
                <span className={styles.legLabel}>Posición LP</span>
                <span className={`${styles.legValue} ${summary.lpNetUsd >= 0 ? styles.positive : styles.negative}`}>
                  {formatSignedUsd(summary.lpNetUsd)}
                </span>
              </span>
              <span className={styles.legDivider} aria-hidden="true" />
              <span className={styles.leg}>
                <span className={styles.legLabel}>Cobertura</span>
                <span className={`${styles.legValue} ${summary.hedgeNetUsd >= 0 ? styles.positive : styles.negative}`}>
                  {formatSignedUsd(summary.hedgeNetUsd)}
                </span>
              </span>
            </summary>
            <div className={styles.legsDetail}>
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
            </div>
          </details>
        )}

        {/* Salud: sólo métricas que EXISTEN en el payload. Un hueco es
            preferible a un número inventado. */}
        {(timeInRangePct != null || priceDelta) && (
          <div className={styles.healthRow}>
            {timeInRangePct != null && (
              <div className={styles.healthChip}>
                <span className={styles.healthLabel}>Tiempo en rango</span>
                <span className={`${styles.healthValue} ${styles[`health_${tirTone(timeInRangePct)}`]}`}>
                  {formatNumber(timeInRangePct, 1)}%
                </span>
              </div>
            )}
            {priceDelta && (
              <div className={styles.healthChip}>
                <span className={styles.healthLabel}>Precio vs apertura</span>
                <span className={`${styles.healthValue} ${styles[`delta_${priceDelta.tone}`]}`}>
                  {priceDelta.text}
                </span>
              </div>
            )}
          </div>
        )}

        <details
          className={styles.strategyBlock}
          open={showStrategy}
          onToggle={(e) => setShowStrategy(e.currentTarget.open)}
        >
          <summary className={styles.strategySummary}>
            <span>Estrategia</span>
            <span className={styles.strategyHint}>
              ±{strategyConfig.rangeWidthPct ?? '?'}% · borde {strategyConfig.edgeMarginPct ?? '?'}%
            </span>
          </summary>
          <div className={styles.strategyGrid}>
            <StrategyCell label="Ancho rango" value={`±${strategyConfig.rangeWidthPct ?? '?'}%`} />
            {(() => {
              const rec = orchestrator.lastEvaluation?.rangeRecommendation;
              const recW = rec?.recommendedWidthPct;
              const curW = Number(strategyConfig.rangeWidthPct);
              if (recW == null || !Number.isFinite(curW) || Math.abs(recW - curW) <= 0.5) return null;
              const dir = recW > curW ? '↑ ensanchar' : '↓ angostar';
              return <StrategyCell label="Ancho sugerido" value={`±${recW}% (${dir})`} highlight />;
            })()}
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

        {/* ── ACCIONES ── Una primaria. El resto y lo destructivo, en el menú. */}
        <div className={styles.footer}>
          <span className={styles.metaInfo}>
            <span className={styles.evalDot} />
            evaluado {formatRelativeTimestamp(orchestrator.lastEvaluationAt)}
          </span>

          <div className={styles.footerActions}>
            <button
              type="button"
              className={`${styles.ghostBtn} ${isEvaluating ? styles.ghostBtnBusy : ''}`}
              onClick={() => onEvaluate(orchestrator)}
              disabled={isEvaluating}
              title="Forzar evaluación inmediata"
            >
              {isEvaluating ? 'Evaluando…' : 'Refrescar'}
            </button>

            {hasActiveLp ? (
              <button
                type="button"
                className={`${styles.primaryBtn} ${primaryAction.tone ? styles[`primaryBtn_${primaryAction.tone}`] : ''}`}
                onClick={() => runAction(primaryAction.id)}
                disabled={!walletConnected}
                title={!walletConnected ? 'Conecta una wallet para firmar' : ''}
              >
                {primaryAction.label}
              </button>
            ) : (
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => onCreateNewLp(orchestrator)}
                disabled={!walletConnected}
                title={!walletConnected ? 'Conecta una wallet para firmar' : ''}
              >
                Crear nuevo LP
              </button>
            )}

            <div className={styles.menuWrap}>
              <button
                type="button"
                className={styles.menuBtn}
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="Más acciones"
              >
                <DotsIcon />
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className={styles.menuScrim}
                    onClick={() => setMenuOpen(false)}
                    aria-label="Cerrar menú de acciones"
                    tabIndex={-1}
                  />
                  <div className={styles.menu} role="menu">
                    <button type="button" role="menuitem" className={styles.menuItem}
                      onClick={() => { setMenuOpen(false); onShowLog?.(orchestrator); }}>
                      Bitácora
                    </button>
                    <button type="button" role="menuitem" className={styles.menuItem}
                      onClick={() => { setMenuOpen(false); onEditConfig?.(orchestrator); }}
                      disabled={!onEditConfig}>
                      Editar configuración
                    </button>

                    {hasActiveLp ? (
                      <>
                        <span className={styles.menuSep} role="separator" />
                        {secondaryActions.map((action) => (
                          <button key={action.id} type="button" role="menuitem" className={styles.menuItem}
                            onClick={() => runAction(action.id)} disabled={!walletConnected}>
                            {action.label}
                          </button>
                        ))}
                        {/* Lo irreversible vive detrás de su propio separador y
                            con su propio color: ya no compite con lo primario. */}
                        <span className={styles.menuSep} role="separator" />
                        <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuItemDanger}`}
                          onClick={() => { setMenuOpen(false); onKill(orchestrator); }}
                          disabled={!walletConnected}
                          title="Cierra el LP activo. La contabilidad del orquestador se conserva.">
                          Matar LP
                        </button>
                        <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuItemDanger}`}
                          onClick={() => { setMenuOpen(false); onKillAndArchive?.(orchestrator); }}
                          disabled={!walletConnected || !onKillAndArchive}
                          title="Cierra el LP conservando los tokens y archiva el orquestador. Irreversible.">
                          Cerrar y archivar
                        </button>
                      </>
                    ) : (
                      <>
                        <span className={styles.menuSep} role="separator" />
                        <button type="button" role="menuitem" className={styles.menuItem}
                          onClick={() => { setMenuOpen(false); onAdoptLp?.(orchestrator); }}
                          disabled={!walletConnected || !onAdoptLp}
                          title="Vincula un LP que ya existe en tu wallet al orquestador.">
                          Adoptar LP existente
                        </button>
                        <span className={styles.menuSep} role="separator" />
                        <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuItemDanger}`}
                          onClick={() => { setMenuOpen(false); onArchive(orchestrator); }}
                          title="Archiva el orquestador. Solo si no hay LP activo.">
                          Archivar
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function tirTone(pct) {
  if (pct == null) return 'neutral';
  if (pct >= 80) return 'ok';
  if (pct >= 50) return 'warn';
  return 'urgent';
}

function StrategyCell({ label, value, highlight = false }) {
  return (
    <div className={styles.strategyCell}>
      <span className={styles.strategyCellLabel}>{label}</span>
      <span className={`${styles.strategyCellValue}${highlight ? ` ${styles.strategyCellValueHighlight}` : ''}`}>
        {value}
      </span>
    </div>
  );
}

function ChevronIcon({ className }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ShieldIcon({ className }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5.5c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6z" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
