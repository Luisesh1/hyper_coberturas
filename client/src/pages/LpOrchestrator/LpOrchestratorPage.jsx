import { useCallback, useEffect, useMemo, useState } from 'react';
import { settingsApi, lpOrchestratorApi, uniswapApi } from '../../services/api';
import { useWalletConnection, useWalletState } from '../../hooks/useWalletConnection';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { EmptyState } from '../../components/shared/EmptyState';
import OrchestratorCard from './components/OrchestratorCard';
import CreateOrchestratorWizard from './components/CreateOrchestratorWizard';
import EditOrchestratorConfigModal from './components/EditOrchestratorConfigModal';
import ActionLogDrawer from './components/ActionLogDrawer';
import OrchestratorIssueModal from './components/OrchestratorIssueModal';
import PositionActionModal from '../UniswapPools/components/PositionActionModal';
import SmartCreatePoolModal from '../UniswapPools/components/SmartCreatePoolModal';
import SmartAddLiquidityModal from '../UniswapPools/components/SmartAddLiquidityModal';
import WalletConnectSetupModal from '../../components/shared/WalletConnectSetupModal';
import { formatUsd } from '../UniswapPools/utils/pool-formatters';
import { formatApiError } from '../../utils/errorFormatter';
import styles from './LpOrchestratorPage.module.css';

const POLL_INTERVAL_MS = 30_000;

const FILTER_OPTIONS = [
  { id: 'all', label: 'Todos' },
  { id: 'active_lp', label: 'Con LP activo' },
  { id: 'idle', label: 'Sin LP' },
  { id: 'attention', label: 'Necesitan atención' },
];

export default function LpOrchestratorPage() {
  const [orchestrators, setOrchestrators] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [activeAction, setActiveAction] = useState(null); // { action, orchestrator, pool }
  const [addingLiquidityTo, setAddingLiquidityTo] = useState(null); // { orchestrator, pool }
  const [creatingLpFor, setCreatingLpFor] = useState(null); // orchestrator
  const [archiveAfterKillId, setArchiveAfterKillId] = useState(null); // orchestrator id
  const [evaluatingId, setEvaluatingId] = useState(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [logDrawerFor, setLogDrawerFor] = useState(null); // orchestrator
  const [issueModalFor, setIssueModalFor] = useState(null);
  const [editConfigFor, setEditConfigFor] = useState(null);
  const [resolvingIssueId, setResolvingIssueId] = useState(null);
  const { dialog, confirm } = useConfirmAction();
  const walletConn = useWalletConnection();

  const walletState = useWalletState();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await lpOrchestratorApi.list({ includeArchived: showInactive });
      setOrchestrators(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(formatApiError(err, 'No se pudo cargar la lista.'));
    } finally {
      setIsLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    async function loadInitial() {
      try {
        const [metaData, accountsData] = await Promise.all([
          uniswapApi.getMeta().catch(() => null),
          settingsApi.getHyperliquidAccounts().catch(() => []),
        ]);
        setMeta(metaData);
        setAccounts(accountsData || []);
      } catch (err) {
        setError(formatApiError(err, 'No se pudo cargar la configuración inicial.'));
      }
    }
    loadInitial().catch(() => {});
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  // Polling cada 30 s
  useEffect(() => {
    const timer = setInterval(() => { refresh().catch(() => {}); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleEvaluate = async (orch) => {
    setEvaluatingId(orch.id);
    try {
      await lpOrchestratorApi.evaluate(orch.id);
      await refresh();
    } catch (err) {
      setError(err.message || 'No se pudo evaluar el orquestador.');
    } finally {
      setEvaluatingId(null);
    }
  };

  const handleResolveIssue = useCallback(async (orch) => {
    if (!orch?.id) return;
    setResolvingIssueId(orch.id);
    setEvaluatingId(orch.id);
    setError('');

    let reconcileError = null;
    try {
      await lpOrchestratorApi.reconcile(orch.id);
    } catch (err) {
      reconcileError = err;
    }

    try {
      await lpOrchestratorApi.evaluate(orch.id);
      await refresh();
      setIssueModalFor(null);
      if (reconcileError) {
        setError(`La reevaluacion corrio, pero la reconciliacion previa fallo: ${reconcileError.message || 'error desconocido'}`);
      }
    } catch (err) {
      const baseMessage = err.message || 'No se pudo forzar la reevaluacion.';
      if (reconcileError) {
        setError(`La reconciliacion y la reevaluacion fallaron: ${reconcileError.message || 'error desconocido'} / ${baseMessage}`);
      } else {
        setError(baseMessage);
      }
    } finally {
      setResolvingIssueId(null);
      setEvaluatingId(null);
    }
  }, [refresh]);

  const handleAction = (action, orchestrator, pool) => {
    if (!walletConn.isConnected) {
      setError('Conecta una wallet antes de firmar acciones.');
      return;
    }
    if (!pool) {
      setError('No hay snapshot del LP. Refresca el orquestador y vuelve a intentar.');
      return;
    }
    // increase-liquidity en el contexto del orquestador usa el flujo smart
    // (USD target + selección de fuentes) en vez del PositionActionModal
    // legacy. El path legacy sigue funcionando desde UniswapPoolsPage.
    if (action === 'increase-liquidity') {
      setAddingLiquidityTo({ orchestrator, pool });
      return;
    }
    // Para modify-range, pre-cargar el rango auto-recentrado al precio actual
    let enrichedPool = pool;
    if (action === 'modify-range') {
      const widthPct = Number(orchestrator.strategyConfig?.rangeWidthPct ?? 5);
      const priceCurrent = Number(pool.priceCurrent);
      if (Number.isFinite(priceCurrent) && widthPct > 0) {
        enrichedPool = {
          ...pool,
          rangeLowerPrice: priceCurrent * (1 - widthPct / 100),
          rangeUpperPrice: priceCurrent * (1 + widthPct / 100),
        };
      }
    }
    setActiveAction({ action, orchestrator, pool: enrichedPool });
  };

  const handleActionFinalized = useCallback(async (finalizeArg) => {
    if (!activeAction) return;
    const { orchestrator, action } = activeAction;
    try {
      const expected = {};
      if (action === 'modify-range') {
        expected.rangeLowerPrice = Number(activeAction.pool?.rangeLowerPrice);
        expected.rangeUpperPrice = Number(activeAction.pool?.rangeUpperPrice);
      }
      const result = await lpOrchestratorApi.recordTxFinalized(orchestrator.id, {
        action,
        finalizeResult: finalizeArg || { txHashes: [] },
        expected,
      });
      // Si era un kill+archive encadenado y la verificación pasó, archivamos
      // automáticamente el orquestador. La condición clave: ya no hay LP activo
      // y el flag estaba pidiendo archivado para este orquestador.
      const wasCloseAction = action === 'close-keep-assets' || action === 'close-to-usdc';
      const verificationOk = result?.verification?.ok !== false;
      if (
        wasCloseAction
        && verificationOk
        && archiveAfterKillId === orchestrator.id
        && !result?.orchestrator?.activePositionIdentifier
      ) {
        try {
          await lpOrchestratorApi.archive(orchestrator.id);
        } catch (archiveErr) {
          setError(archiveErr.message || 'El LP se cerró pero el archivo del orquestador falló.');
        }
      }
    } catch (err) {
      setError(err.message || 'No se pudo registrar el resultado de la acción.');
      // Recovery: si recordTxFinalized falló (ej. timeout del cliente), el
      // backend probablemente sí completó el cambio on-chain. Disparamos un
      // reconcile manual para que el orquestador detecte el nuevo
      // positionIdentifier y aplique la contabilidad sin esperar al monitor.
      lpOrchestratorApi.reconcile(orchestrator.id).catch(() => {});
    } finally {
      setActiveAction(null);
      setArchiveAfterKillId(null);
      refresh().catch(() => {});
    }
  }, [activeAction, archiveAfterKillId, refresh]);

  /**
   * Cuando el usuario cierra la modal manualmente (sin que `onFinalized` se
   * dispare) tras un error o timeout, intentamos un reconcile silencioso.
   * El backend ya sabe detectar la nueva posición creada por el modify-range
   * que sí se ejecutó on-chain pero cuyo `recordTxFinalized` no llegó.
   */
  const handleActionModalClose = useCallback(() => {
    const orchestratorId = activeAction?.orchestrator?.id;
    setActiveAction(null);
    setArchiveAfterKillId(null);
    if (orchestratorId) {
      lpOrchestratorApi.reconcile(orchestratorId)
        .catch(() => {})
        .finally(() => { refresh().catch(() => {}); });
    } else {
      refresh().catch(() => {});
    }
  }, [activeAction, refresh]);

  const handleKill = async (orchestrator) => {
    const ok = await confirm({
      title: 'Cerrar LP',
      message: '¿Seguro que quieres cerrar el LP activo? Si el par tiene una stablecoin, los activos se convertirán automáticamente. El orquestador quedará en idle.',
      confirmLabel: 'Cerrar LP',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const response = await lpOrchestratorApi.killLp(orchestrator.id, { mode: 'auto' });
      // Recovery: el backend detectó que la posición ya está cerrada on-chain
      // (típicamente porque un modify-range previo no pudo registrarse). En ese
      // caso ya limpió el activePositionIdentifier — solo refrescamos.
      if (response?.alreadyClosed) {
        setError('');
        await refresh().catch(() => {});
        return;
      }
      const { action, prepareResult } = response;
      // Disparamos PositionActionModal con la acción ya determinada por el backend.
      setActiveAction({
        action,
        orchestrator,
        pool: orchestrator.lastEvaluation?.poolSnapshot
          ? buildPool(orchestrator)
          : { identifier: orchestrator.activePositionIdentifier, network: orchestrator.network, version: orchestrator.version },
        prefilledPrepareResult: prepareResult,
      });
    } catch (err) {
      setError(err.message || 'No se pudo preparar el cierre.');
    }
  };

  /**
   * Cierra el LP conservando los tokens (sin convertir a stable) y, una vez
   * verificado el cierre on-chain, archiva el orquestador automáticamente.
   * El encadenamiento se hace en `handleActionFinalized` mirando el flag
   * `archiveAfterKillId`.
   */
  const handleKillAndArchive = async (orchestrator) => {
    const ok = await confirm({
      title: 'Cerrar LP y archivar orquestador',
      message: '¿Seguro? Los tokens del LP volverán a la wallet sin convertirse a USDC/USDT. Tras la confirmación on-chain, el orquestador se archivará automáticamente. Esta acción es IRREVERSIBLE.',
      confirmLabel: 'Cerrar y archivar',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const response = await lpOrchestratorApi.killLp(orchestrator.id, { mode: 'keep' });
      // Recovery: la posición ya está cerrada on-chain, solo necesitamos
      // archivar el orquestador (el backend ya limpió activePositionIdentifier).
      if (response?.alreadyClosed) {
        try {
          await lpOrchestratorApi.archive(orchestrator.id);
          setError('');
        } catch (archiveErr) {
          setError(archiveErr.message || 'El LP ya estaba cerrado pero el archivo del orquestador falló.');
        }
        await refresh().catch(() => {});
        return;
      }
      const { action, prepareResult } = response;
      setArchiveAfterKillId(orchestrator.id);
      setActiveAction({
        action,
        orchestrator,
        pool: orchestrator.lastEvaluation?.poolSnapshot
          ? buildPool(orchestrator)
          : { identifier: orchestrator.activePositionIdentifier, network: orchestrator.network, version: orchestrator.version },
        prefilledPrepareResult: prepareResult,
      });
    } catch (err) {
      setError(err.message || 'No se pudo preparar el cierre.');
    }
  };

  const handleArchive = async (orchestrator) => {
    const ok = await confirm({
      title: 'Archivar orquestador',
      message: 'Esta acción es irreversible. ¿Seguro que quieres archivar este orquestador?',
      confirmLabel: 'Archivar',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await lpOrchestratorApi.archive(orchestrator.id);
      await refresh();
    } catch (err) {
      setError(err.message || 'No se pudo archivar.');
    }
  };

  const handleCreateNewLp = (orchestrator) => {
    if (!walletConn.isConnected) {
      setError('Conecta una wallet antes de crear el LP.');
      return;
    }
    setCreatingLpFor(orchestrator);
  };

  // Adopta un LP huérfano: escanea la wallet, busca posiciones del mismo
  // par/red/fee, y vincula la primera (o le pide al usuario que elija si
  // hay varias). Cubre el caso de un attach-lp que falló por race condition.
  const handleAdoptLp = useCallback(async (orchestrator) => {
    if (!walletConn.isConnected) {
      setError('Conecta una wallet antes de adoptar un LP.');
      return;
    }
    setError('');
    try {
      const response = await lpOrchestratorApi.listAdoptableLps(orchestrator.id);
      const candidates = response?.data?.candidates || [];
      if (candidates.length === 0) {
        const reason = response?.data?.reason;
        if (reason === 'scan_failed') {
          setError('No se pudo escanear la wallet en este momento. Reintenta en unos segundos.');
        } else if (reason === 'already_has_lp') {
          setError('Este orquestador ya tiene un LP activo.');
        } else {
          setError(`No hay LPs en tu wallet que coincidan con ${orchestrator.token0Symbol}/${orchestrator.token1Symbol} (${orchestrator.network}, fee ${(orchestrator.feeTier / 10_000).toFixed(2)}%).`);
        }
        return;
      }

      // Si hay un solo candidato, pedimos confirmación rápida.
      // Si hay más de uno, mostramos un picker simple con prompt para
      // que el usuario elija el tokenId. (Más adelante podemos hacer un
      // modal lindo si esto se usa seguido.)
      let chosen = candidates[0];
      if (candidates.length > 1) {
        const list = candidates
          .map((c, idx) => `${idx + 1}. NFT #${c.identifier} — valor ~${formatUsd(c.currentValueUsd)} ${c.inRange ? '(en rango)' : '(fuera de rango)'}`)
          .join('\n');
        // eslint-disable-next-line no-alert
        const pick = window.prompt(
          `Encontré ${candidates.length} LPs ${orchestrator.token0Symbol}/${orchestrator.token1Symbol} en tu wallet:\n\n${list}\n\nEscribe el número del LP a adoptar:`,
          '1'
        );
        const pickIdx = Number(pick) - 1;
        if (!Number.isInteger(pickIdx) || pickIdx < 0 || pickIdx >= candidates.length) {
          return; // user cancelled or invalid input
        }
        chosen = candidates[pickIdx];
      } else {
        // eslint-disable-next-line no-alert
        const ok = window.confirm(
          `Adoptar el LP #${chosen.identifier} (~${formatUsd(chosen.currentValueUsd)}, ${chosen.inRange ? 'en rango' : 'fuera de rango'}) en este orquestador?`
        );
        if (!ok) return;
      }

      await lpOrchestratorApi.adoptLp(orchestrator.id, {
        positionIdentifier: chosen.identifier,
        protectionConfig: orchestrator.protectionConfig || { enabled: false },
      });
      await refresh();
    } catch (err) {
      setError(err.message || 'No se pudo adoptar el LP.');
    }
  }, [walletConn.isConnected, refresh]);

  const handleSmartCreateFinalized = useCallback(async (finalizeArg) => {
    if (!creatingLpFor) return;
    // SmartCreatePoolModal entrega { txHashes, finalizeResult }. El backend
    // espera el shape interno (con positionChanges/refreshedSnapshot), así
    // que desempaquetamos antes de adjuntar y propagamos los txHashes.
    const innerFinalize = finalizeArg?.finalizeResult || finalizeArg || {};
    const txHashes = finalizeArg?.txHashes || innerFinalize?.txHashes || [];
    const attachPayload = { ...innerFinalize, txHashes };
    try {
      await lpOrchestratorApi.attachLp(creatingLpFor.id, {
        finalizeResult: attachPayload,
        protectionConfig: creatingLpFor.protectionConfig || { enabled: false },
      });
    } catch (err) {
      // El attach-lp falló (probablemente race condition con shutdown del
      // server, o un timeout). El LP YA está creado on-chain — informamos
      // al usuario y le indicamos cómo recuperarlo con "Adoptar LP existente".
      const friendlyMessage = `${err.message || 'No se pudo adjuntar el LP al orquestador.'} El LP YA está en tu wallet — usa "Adoptar LP existente" en el orquestador para vincularlo.`;
      setError(friendlyMessage);
    } finally {
      setCreatingLpFor(null);
      refresh().catch(() => {});
    }
  }, [creatingLpFor, refresh]);

  const summary = useMemo(() => {
    const active = orchestrators.filter((o) => o.status === 'active');
    return {
      total: orchestrators.length,
      active: active.length,
      withLp: active.filter((o) => !!o.activePositionIdentifier).length,
      idle: active.filter((o) => !o.activePositionIdentifier).length,
      urgent: active.filter((o) => o.phase === 'urgent_adjust' || o.phase === 'failed').length,
      needsRebalance: active.filter((o) => o.phase === 'needs_rebalance').length,
    };
  }, [orchestrators]);

  const visibleOrchestrators = useMemo(() => {
    let list = orchestrators;
    if (!showInactive) list = list.filter((o) => o.status === 'active');

    if (filter === 'active_lp') {
      list = list.filter((o) => !!o.activePositionIdentifier);
    } else if (filter === 'idle') {
      list = list.filter((o) => !o.activePositionIdentifier && o.status === 'active');
    } else if (filter === 'attention') {
      list = list.filter((o) => ['urgent_adjust', 'needs_rebalance', 'failed'].includes(o.phase));
    }

    const term = searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter((o) => {
        const haystack = [
          o.name, o.token0Symbol, o.token1Symbol, o.network, o.version,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(term);
      });
    }

    // Orden: urgent → needs_rebalance → failed → con LP activo → idle → archivados
    const priority = (o) => {
      if (o.phase === 'urgent_adjust') return 0;
      if (o.phase === 'failed') return 1;
      if (o.phase === 'needs_rebalance') return 2;
      if (o.activePositionIdentifier) return 3;
      if (o.status === 'archived') return 5;
      return 4;
    };
    return [...list].sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }, [orchestrators, showInactive, filter, searchTerm]);

  const positionActionDefaults = useMemo(() => {
    if (!activeAction) return {};
    const orch = activeAction.orchestrator;
    return {
      network: orch.network,
      version: orch.version,
      walletAddress: walletConn.address || orch.walletAddress,
    };
  }, [activeAction, walletConn.address]);

  const smartCreateDefaults = useMemo(() => {
    if (!creatingLpFor) return null;
    return {
      network: creatingLpFor.network,
      version: creatingLpFor.version,
      walletAddress: walletConn.address || creatingLpFor.walletAddress,
      // Pre-cargamos par/fee/capital del orquestador para que el modal salte
      // el primer paso y no pida los mismos datos que el wizard ya recogió.
      token0Address: creatingLpFor.token0Address,
      token1Address: creatingLpFor.token1Address,
      fee: creatingLpFor.feeTier,
      totalUsdTarget: creatingLpFor.initialTotalUsd,
    };
  }, [creatingLpFor, walletConn.address]);

  return (
    <div className={styles.page}>
      <header className={styles.headerRow}>
        <div className={styles.headerLeft}>
          <span className={styles.eyebrow}>LP Orchestrator</span>
          <h1 className={styles.title}>🎛 Orquestador de LP</h1>
          <p className={styles.subtitle}>
            Automatiza seguimiento, contabilidad y alertas del LP. El usuario solo firma los cambios on-chain.
          </p>
        </div>
        <div className={styles.headerActions}>
          {summary.total > 0 && (
            <div className={styles.summaryStrip}>
              <SummaryStat label="Activos" value={summary.active} tone="info" />
              <SummaryStat label="Con LP" value={summary.withLp} tone="ok" />
              <SummaryStat
                label="Atención"
                value={summary.needsRebalance + summary.urgent}
                tone={summary.urgent > 0 ? 'urgent' : summary.needsRebalance > 0 ? 'warn' : 'muted'}
              />
            </div>
          )}
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => setShowWizard(true)}
          >
            ＋ Crear orquestador
          </button>
        </div>
      </header>

      <div className={styles.walletBar}>
        {walletConn.isConnected ? (
          <span className={styles.walletConnected}>
            <span className={styles.walletDot} />
            {walletConn.address.slice(0, 6)}...{walletConn.address.slice(-4)}
            {walletConn.chainId && <span className={styles.walletChain}>Red {walletConn.chainId} · {walletConn.connectorLabel}</span>}
          </span>
        ) : (
          <>
            <button className={styles.walletBtn} onClick={walletConn.connectInjected} disabled={!walletConn.hasInjectedProvider}>
              🦊 Conectar con MetaMask
            </button>
            <button className={styles.walletGhostBtn} onClick={walletConn.connectWalletConnect} disabled={!walletConn.hasWalletConnect}>
              🔗 WalletConnect
            </button>
          </>
        )}
        {walletConn.isConnected && (
          <button className={styles.walletGhostBtn} onClick={walletConn.disconnect}>
            ↩ Desconectar
          </button>
        )}
        <div className={styles.spacer} />
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Mostrar archivados
        </label>
      </div>

      {orchestrators.length > 0 && (
        <div className={styles.filterBar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Buscar por nombre, par o red…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearchTerm('')}
                aria-label="Limpiar búsqueda"
              >
                ✕
              </button>
            )}
          </div>
          <div className={styles.filterChips}>
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`${styles.chip} ${filter === opt.id ? styles.chipActive : ''}`}
                onClick={() => setFilter(opt.id)}
              >
                {opt.label}
                {opt.id === 'attention' && (summary.urgent + summary.needsRebalance) > 0 && (
                  <span className={styles.chipBadge}>{summary.urgent + summary.needsRebalance}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!accounts.length && (
        <div className={styles.notice}>
          ℹ Sin cuentas de Hyperliquid — puedes crear orquestadores sin protección. Ve a Configuración para agregar una.
        </div>
      )}
      {error && (
        <div className={styles.noticeError}>
          <span>{error}</span>
          <button className={styles.dismissBtn} onClick={() => setError('')}>✕</button>
        </div>
      )}

      {visibleOrchestrators.length === 0 && !isLoading && (
        <EmptyState
          icon="🎛"
          title="Aún no hay orquestadores"
          description="Crea uno para empezar a automatizar el seguimiento de tus LPs."
        />
      )}

      <div className={styles.grid}>
        {visibleOrchestrators.map((orch) => (
          <OrchestratorCard
            key={orch.id}
            orchestrator={orch}
            isEvaluating={evaluatingId === orch.id}
            walletConnected={walletConn.isConnected}
            onEvaluate={handleEvaluate}
            onAction={handleAction}
            onKill={handleKill}
            onKillAndArchive={handleKillAndArchive}
            onArchive={handleArchive}
            onCreateNewLp={handleCreateNewLp}
            onAdoptLp={handleAdoptLp}
            onShowLog={setLogDrawerFor}
            onShowIssue={setIssueModalFor}
            onEditConfig={setEditConfigFor}
          />
        ))}
      </div>

      {editConfigFor && (
        <EditOrchestratorConfigModal
          orchestrator={editConfigFor}
          accounts={accounts}
          onClose={() => setEditConfigFor(null)}
          onSaved={() => {
            setEditConfigFor(null);
            refresh().catch(() => {});
          }}
        />
      )}

      {showWizard && (
        <CreateOrchestratorWizard
          network="arbitrum"
          version="v3"
          walletAddress={walletConn.address}
          accounts={accounts}
          onClose={() => setShowWizard(false)}
          onCreated={(created) => {
            setShowWizard(false);
            refresh().catch(() => {});
            // Encadenamos la creación del LP con los datos del orquestador
            // recién creado: el SmartCreatePoolModal recibe par/fee/capital
            // y salta directamente al paso de rango.
            if (created && walletConn.isConnected) {
              setCreatingLpFor(created);
            }
          }}
        />
      )}

      {activeAction && (
        <PositionActionModal
          action={activeAction.action}
          pool={activeAction.pool}
          wallet={walletState}
          sendTransaction={walletConn.sendTransaction}
          waitForTransactionReceipt={walletConn.waitForTransactionReceipt}
          defaults={positionActionDefaults}
          prefilledPrepareResult={activeAction.prefilledPrepareResult || null}
          onClose={handleActionModalClose}
          onFinalized={handleActionFinalized}
        />
      )}

      {addingLiquidityTo && (
        <SmartAddLiquidityModal
          wallet={walletState}
          sendTransaction={walletConn.sendTransaction}
          waitForTransactionReceipt={walletConn.waitForTransactionReceipt}
          pool={addingLiquidityTo.pool}
          defaults={{
            network: addingLiquidityTo.orchestrator.network,
            version: addingLiquidityTo.orchestrator.version,
            walletAddress: walletConn.address,
            positionIdentifier: addingLiquidityTo.pool.identifier
              || addingLiquidityTo.pool.positionIdentifier
              || addingLiquidityTo.orchestrator.activePositionIdentifier,
            defaultTotalUsdTarget: Number(addingLiquidityTo.pool.currentValueUsd) || 500,
          }}
          onClose={() => setAddingLiquidityTo(null)}
          onFinalized={(finalizeResult) => {
            const orchestratorId = addingLiquidityTo.orchestrator.id;
            setAddingLiquidityTo(null);
            // Reusamos `recordTxFinalized` directamente para que la
            // contabilidad del orquestador (capitalAdjustmentsUsd) registre
            // el aumento. El recordTxFinalized de la orquestación detecta
            // increase-liquidity y diffea pre/post snapshots.
            lpOrchestratorApi.recordTxFinalized(orchestratorId, {
              action: 'increase-liquidity',
              finalizeResult: finalizeResult || { txHashes: [] },
              expected: {},
            })
              .catch((err) => setError(err.message || 'No se pudo registrar el aumento de liquidez.'))
              .finally(() => { refresh().catch(() => {}); });
          }}
        />
      )}

      {creatingLpFor && smartCreateDefaults && (
        <SmartCreatePoolModal
          wallet={walletState}
          sendTransaction={walletConn.sendTransaction}
          waitForTransactionReceipt={walletConn.waitForTransactionReceipt}
          defaults={smartCreateDefaults}
          meta={meta}
          onClose={() => setCreatingLpFor(null)}
          onFinalized={handleSmartCreateFinalized}
        />
      )}

      {logDrawerFor && (
        <ActionLogDrawer
          orchestrator={logDrawerFor}
          onClose={() => setLogDrawerFor(null)}
        />
      )}

      {issueModalFor && (
        <OrchestratorIssueModal
          orchestrator={issueModalFor}
          isResolving={resolvingIssueId === issueModalFor.id}
          onClose={() => setIssueModalFor(null)}
          onResolve={handleResolveIssue}
          onShowLog={(orch) => {
            setIssueModalFor(null);
            setLogDrawerFor(orch);
          }}
        />
      )}

      {walletConn.needsWalletConnectSetup && (
        <WalletConnectSetupModal
          initialValue={walletConn.walletConnectProjectId}
          onSave={(id) => walletConn.setWalletConnectProjectId(id)}
          onClose={() => walletConn.dismissWalletConnectSetup()}
          onSavedConnect={() => {
            // Tras guardar, intentamos conectar inmediatamente. Como el state
            // del project ID acaba de actualizarse, llamamos en el próximo
            // tick para que el closure de connectWalletConnect lo lea.
            setTimeout(() => walletConn.connectWalletConnect().catch(() => {}), 50);
          }}
        />
      )}

      {dialog && <ConfirmDialog {...dialog} />}
    </div>
  );
}

function SummaryStat({ label, value, tone }) {
  return (
    <div className={`${styles.statCell} ${styles[`stat_${tone}`] || ''}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function buildPool(orchestrator) {
  const pool = orchestrator.lastEvaluation?.poolSnapshot;
  if (!pool) return null;
  return {
    ...pool,
    token0: pool.token0 || { symbol: orchestrator.token0Symbol },
    token1: pool.token1 || { symbol: orchestrator.token1Symbol },
    network: pool.network || orchestrator.network,
    version: pool.version || orchestrator.version,
    identifier: pool.identifier || orchestrator.activePositionIdentifier,
    positionIdentifier: pool.positionIdentifier || orchestrator.activePositionIdentifier,
  };
}
