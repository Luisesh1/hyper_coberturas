import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settingsApi, uniswapApi, tradingApi } from '../../services/api';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { EmptyState } from '../../components/shared/EmptyState';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { useWalletConnection, useWalletState } from '../../hooks/useWalletConnection';
import { mergeResultProtections } from './utils/pool-sorting';
import { getPoolSortScore } from './utils/pool-sorting';
import { sortProtectedPools } from './utils/pool-sorting';
import { isPoolEligible } from './utils/pool-helpers';
import ScannerBar from './components/ScannerBar';
import ResultsToolbar from './components/ResultsToolbar';
import PoolCard from './components/PoolCard';
import ProtectedPoolCard from './components/ProtectedPoolCard';
import ApplyProtectionModal from './components/ApplyProtectionModal';
import PositionActionModal from './components/PositionActionModal';
import SmartCreatePoolModal from './components/SmartCreatePoolModal';
import SkeletonCard from './components/SkeletonCard';
import WalletConnectSetupModal from '../../components/shared/WalletConnectSetupModal';
import styles from './UniswapPoolsPage.module.css';

const PROTECTED_POOLS_REFRESH_INTERVAL_MS = 600000;
const EMPTY_WALLET_CONNECTION = {
  address: '',
  chainId: null,
  isConnected: false,
  hasProvider: false,
  connector: null,
  connectorLabel: '',
  error: '',
  hasInjectedProvider: false,
  hasWalletConnect: false,
  needsWalletConnectSetup: false,
  walletConnectProjectId: '',
  connectInjected: () => {},
  connectWalletConnect: async () => null,
  disconnect: async () => null,
  sendTransaction: async () => null,
  waitForTransactionReceipt: async () => null,
  setWalletConnectProjectId: () => {},
  dismissWalletConnectSetup: () => {},
};

export default function UniswapPoolsPage() {
  const [meta, setMeta] = useState(null);
  const [wallet, setWallet] = useState('');
  const [network, setNetwork] = useState('arbitrum');
  const [version, setVersion] = useState('v3');
  const [result, setResult] = useState(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [protectedPools, setProtectedPools] = useState([]);
  const [protectedRefreshedAt, setProtectedRefreshedAt] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [resultFilter, setResultFilter] = useState('all');
  const [sortBy, setSortBy] = useState('value');
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isApplyingProtection, setIsApplyingProtection] = useState(false);
  const [isLoadingProtected, setIsLoadingProtected] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState(null);
  const [applyPool, setApplyPool] = useState(null);
  const [activeTab, setActiveTab] = useState('results');
  const [showInactiveProtected, setShowInactiveProtected] = useState(false);
  const [activeAction, setActiveAction] = useState(null);
  const [showSmartCreate, setShowSmartCreate] = useState(false);
  const { dialog, confirm } = useConfirmAction();
  const walletConn = useWalletConnection() || EMPTY_WALLET_CONNECTION;
  const walletState = useWalletState();
  const positionActionDefaults = useMemo(
    () => ({ network, version, walletAddress: walletState.address }),
    [network, version, walletState.address],
  );

  const loadProtectedPools = useCallback(async ({ force = false } = {}) => {
    setIsLoadingProtected(true);
    try {
      const data = force
        ? await uniswapApi.refreshProtectedPools()
        : await uniswapApi.listProtectedPools();
      setProtectedPools(data);
      setProtectedRefreshedAt(Date.now());
      setResult((prev) => mergeResultProtections(prev, data));
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setIsLoadingProtected(false);
    }
  }, []);

  useEffect(() => {
    async function loadInitial() {
      try {
        const [metaData, walletData, etherscanData, accountsData, protectedData] = await Promise.all([
          uniswapApi.getMeta(),
          settingsApi.getWallet().catch(() => null),
          settingsApi.getEtherscan().catch(() => ({ hasApiKey: false })),
          settingsApi.getHyperliquidAccounts().catch(() => []),
          uniswapApi.listProtectedPools().catch(() => []),
        ]);

        // Cargar balances en vivo de cada cuenta
        const accountsWithBalances = await Promise.all(
          (accountsData || []).map(async (account) => {
            try {
              const accountData = await tradingApi.getAccount({ accountId: account.id });
              return {
                ...account,
                balanceUsd: accountData.accountValue || 0,
                totalMarginUsed: accountData.totalMarginUsed || 0,
                withdrawable: accountData.withdrawable || 0,
                lastUpdatedAt: accountData.lastUpdatedAt,
              };
            } catch (err) {
              console.warn(`Failed to load balance for account ${account.id}:`, err.message);
              return account;
            }
          })
        );

        setMeta(metaData);
        setHasApiKey(etherscanData?.hasApiKey || false);
        setAccounts(accountsWithBalances);
        setProtectedPools(protectedData || []);
        setProtectedRefreshedAt(Date.now());
        if (walletData?.address) setWallet(walletData.address);
      } catch (err) {
        setError(err.message);
      }
    }
    loadInitial().catch(() => {});
  }, []);

  // Refrescar saldos de cuentas cada 30 segundos
  // Usamos ref para evitar que el intervalo se reinicie cada vez que accounts cambia
  const accountsRef = useRef(accounts);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!accountsRef.current.length) return;
      try {
        const updatedAccounts = await Promise.all(
          accountsRef.current.map(async (account) => {
            try {
              const accountData = await tradingApi.getAccount({ accountId: account.id });
              return {
                ...account,
                balanceUsd: accountData.accountValue || 0,
                totalMarginUsed: accountData.totalMarginUsed || 0,
                withdrawable: accountData.withdrawable || 0,
                lastUpdatedAt: accountData.lastUpdatedAt,
              };
            } catch (err) {
              return account;
            }
          })
        );
        setAccounts(updatedAccounts);
      } catch (err) {
        console.error('Error refreshing account balances:', err);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []); // deps vacío — el intervalo no se reinicia

  useEffect(() => {
    const interval = setInterval(() => {
      loadProtectedPools().catch(() => {});
    }, PROTECTED_POOLS_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadProtectedPools]);

  useEffect(() => {
    setResult((prev) => mergeResultProtections(prev, protectedPools));
  }, [protectedPools]);

  const selectedNetwork = useMemo(
    () => meta?.networks?.find((item) => item.id === network) || null,
    [meta, network]
  );

  const availableVersions = selectedNetwork?.versions || ['v3'];
  const isLpModeSelection = version === 'v3' || version === 'v4';

  useEffect(() => {
    if (!availableVersions.includes(version)) setVersion(availableVersions[0]);
  }, [availableVersions, version]);

  const activeProtections = useMemo(
    () => protectedPools.filter((item) => item.status === 'active'),
    [protectedPools]
  );

  const protectedSummary = useMemo(() => {
    const outside = activeProtections.filter((item) => item.poolSnapshot?.currentOutOfRangeSide).length;
    const inRange = activeProtections.filter((item) => !item.poolSnapshot?.currentOutOfRangeSide).length;
    return { total: protectedPools.length, active: activeProtections.length, outside, inRange };
  }, [activeProtections, protectedPools.length]);

  const orderedProtectedPools = useMemo(
    () => sortProtectedPools(protectedPools),
    [protectedPools]
  );

  const orderedActiveProtectedPools = useMemo(
    () => orderedProtectedPools.filter((item) => item.status === 'active'),
    [orderedProtectedPools]
  );

  const visibleProtectedPools = showInactiveProtected ? orderedProtectedPools : orderedActiveProtectedPools;

  // Compute filter counts for toolbar chips
  const filterCounts = useMemo(() => {
    if (!result?.pools) return { all: 0, eligible: 0, protected: 0 };
    const query = searchTerm.trim().toLowerCase();
    const searched = result.pools.filter((pool) => {
      if (!query) return true;
      const haystack = [pool.token0?.symbol, pool.token1?.symbol, pool.networkLabel, pool.version, pool.protectionCandidate?.inferredAsset]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
    return {
      all: searched.length,
      eligible: searched.filter((p) => isPoolEligible(p)).length,
      protected: searched.filter((p) => p.protection).length,
    };
  }, [result, searchTerm]);

  const filteredPools = useMemo(() => {
    if (!result?.pools) return [];
    const query = searchTerm.trim().toLowerCase();
    return [...result.pools]
      .filter((pool) => {
        if (query) {
          const haystack = [pool.token0?.symbol, pool.token1?.symbol, pool.networkLabel, pool.version, pool.protectionCandidate?.inferredAsset]
            .filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (resultFilter === 'eligible' && !isPoolEligible(pool)) return false;
        if (resultFilter === 'protected' && !pool.protection) return false;
        return true;
      })
      .sort((a, b) => getPoolSortScore(b, sortBy) - getPoolSortScore(a, sortBy));
  }, [result, resultFilter, searchTerm, sortBy]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsScanning(true);
    setError('');
    try {
      const data = await uniswapApi.scanPools({ wallet, network, version });
      setResult(mergeResultProtections(data, protectedPools));
      setActiveTab('results');
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setIsScanning(false);
    }
  };

  const handleOpenApply = (pool) => {
    if (!accounts.length) {
      setError('Configura una cuenta de Hyperliquid antes de aplicar una cobertura.');
      return;
    }
    if (!isPoolEligible(pool)) {
      setError(pool?.protectionCandidate?.reason || pool?.protectionCandidate?.deltaNeutralReason || 'Este pool no es elegible para proteccion automatica.');
      return;
    }
    setApplyPool(pool);
  };

  const handleApplyProtection = async ({
    pool,
    accountId,
    leverage,
    configuredNotionalUsd,
    valueMultiplier,
    stopLossDifferencePct,
    protectionMode,
    reentryBufferPct,
    flipCooldownSec,
    maxSequentialFlips,
    breakoutConfirmDistancePct,
    breakoutConfirmDurationSec,
    bandMode,
    baseRebalancePriceMovePct,
    rebalanceIntervalSec,
    targetHedgeRatio,
    minRebalanceNotionalUsd,
    maxSlippageBps,
    twapMinNotionalUsd,
  }) => {
    setIsApplyingProtection(true);
    setError('');
    try {
      await uniswapApi.createProtectedPool({
        pool,
        accountId,
        leverage,
        configuredNotionalUsd,
        valueMultiplier,
        stopLossDifferencePct,
        protectionMode,
        reentryBufferPct,
        flipCooldownSec,
        maxSequentialFlips,
        breakoutConfirmDistancePct,
        breakoutConfirmDurationSec,
        bandMode,
        baseRebalancePriceMovePct,
        rebalanceIntervalSec,
        targetHedgeRatio,
        minRebalanceNotionalUsd,
        maxSlippageBps,
        twapMinNotionalUsd,
      });
      setApplyPool(null);
      await loadProtectedPools();
      setActiveTab('protected');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsApplyingProtection(false);
    }
  };

  const refreshVisibleData = useCallback(async () => {
    const fresh = await loadProtectedPools();
    if (result) {
      const data = await uniswapApi.scanPools({ wallet, network, version });
      setResult(mergeResultProtections(data, fresh ?? protectedPools));
    }
  }, [loadProtectedPools, network, protectedPools, result, version, wallet]);

  const handleOpenAction = useCallback((action, pool = null) => {
    setActiveAction({ action, pool });
  }, []);

  const handleClaimFinalized = useCallback(() => {
    refreshVisibleData().catch(() => {});
  }, [refreshVisibleData]);

  const handleDeactivate = async (protection) => {
    const ok = await confirm({
      title: 'Desactivar protección',
      message: `Se cancelarán las dos coberturas ligadas a ${protection.token0Symbol}/${protection.token1Symbol}.`,
      confirmLabel: 'Desactivar protección',
      variant: 'danger',
    });
    if (!ok) return;

    setDeactivatingId(protection.id);
    setError('');
    try {
      await uniswapApi.deactivateProtectedPool(protection.id);
      await loadProtectedPools();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeactivatingId(null);
    }
  };

  return (
    <div className={styles.page}>
      <ScannerBar
        wallet={wallet} setWallet={setWallet}
        network={network} setNetwork={setNetwork}
        version={version} setVersion={setVersion}
        meta={meta} selectedNetwork={selectedNetwork}
        hasApiKey={hasApiKey} accounts={accounts}
        isScanning={isScanning}
        protectedSummary={protectedSummary}
        protectedRefreshedAt={protectedRefreshedAt}
        availableVersions={availableVersions}
        onSubmit={handleSubmit}
      />

      <div className={styles.walletBar}>
        {walletConn.isConnected ? (
          <>
            <span className={styles.walletConnected}>
              <span className={styles.walletDot} />
              {walletConn.address.slice(0, 6)}...{walletConn.address.slice(-4)}
              {walletConn.chainId && <span className={styles.walletChain}>Red {walletConn.chainId} · {walletConn.connectorLabel}</span>}
            </span>
            <button className={styles.walletBtn} onClick={() => setShowSmartCreate(true)}>
              ＋ Nueva posición LP
            </button>
            <button className={styles.walletGhostBtn} onClick={walletConn.disconnect}>
              ↩ Desconectar wallet
            </button>
          </>
        ) : (
          <>
            <button className={styles.walletBtn} onClick={walletConn.connectInjected} disabled={!walletConn.hasInjectedProvider}>
              🦊 Conectar con MetaMask
            </button>
            <button className={styles.walletGhostBtn} onClick={walletConn.connectWalletConnect} disabled={!walletConn.hasWalletConnect}>
              🔗 WalletConnect
            </button>
            {!walletConn.hasInjectedProvider && !walletConn.hasWalletConnect && (
              <span className={styles.walletHint}>No se detectó ninguna extensión de wallet instalada</span>
            )}
          </>
        )}
        {walletConn.error && <span className={styles.walletError}>{walletConn.error}</span>}
      </div>

      {!hasApiKey && (
        <div className={styles.notice}>
          ⚠ Necesitas una API key de Etherscan para escanear wallets. Ve a Configuración → Etherscan para añadirla.
        </div>
      )}
      {!accounts.length && (
        <div className={styles.notice}>
          ℹ Sin cuentas de Hyperliquid — puedes escanear pools, pero no activar protecciones. Ve a Configuración para agregar una.
        </div>
      )}
      {error && (
        <div className={styles.noticeError}>
          <span>{error}</span>
          <button className={styles.dismissBtn} onClick={() => setError('')} aria-label="Cerrar error">✕</button>
        </div>
      )}
      {result?.warnings?.length > 0 && (
        <div className={styles.notice}>{result.warnings.join(' · ')}</div>
      )}

      {/* Tabs */}
      <div className={styles.tabBar}>
        <button
          className={`${styles.tab} ${activeTab === 'results' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('results')}
        >
          🔍 Escaneo
          {result?.count > 0 && <span className={styles.tabCount}>{filteredPools.length}</span>}
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'protected' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('protected')}
        >
          🛡 Protecciones
          {protectedSummary.active > 0 && (
            <span className={`${styles.tabCount} ${protectedSummary.outside > 0 ? styles.tabCountAlert : ''}`}>
              {protectedSummary.active}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'results' && (
        <section className={styles.tabContent}>
          {!result && !isScanning && (
            <EmptyState
              icon="🦄"
              title="Listo para escanear una wallet"
              description="Usa la barra superior para buscar posiciones LP de Uniswap y encontrar pools listos para proteger."
            />
          )}

          {isScanning && (
            <div className={styles.grid}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          )}

          {result && !isScanning && (
            <>
              <ResultsToolbar
                searchTerm={searchTerm} setSearchTerm={setSearchTerm}
                resultFilter={resultFilter} setResultFilter={setResultFilter}
                sortBy={sortBy} setSortBy={setSortBy}
                filteredCount={filteredPools.length}
                totalCount={result.count}
                filterCounts={filterCounts}
              />

              {filteredPools.length === 0 ? (
                <EmptyState
                  icon={result.count === 0 ? '📭' : '🔍'}
                  title={result.count === 0
                    ? isLpModeSelection
                      ? 'No se encontraron posiciones LP activas.'
                      : 'No se encontraron pools con liquidez relevante.'
                    : 'Ningun pool coincide con los filtros actuales.'}
                  description={result.count === 0
                    ? 'Prueba con otra red, version o wallet.'
                    : 'Ajusta la busqueda, el filtro o el orden para explorar otros resultados.'}
                />
              ) : (
                <div className={styles.grid}>
                  {filteredPools.map((pool) => (
                    <PoolCard
                      key={pool.id}
                      pool={pool}
                      hasAccounts={accounts.length > 0}
                      onApplyProtection={handleOpenApply}
                      walletState={walletState}
                      onClaimFees={handleOpenAction}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'protected' && (
        <section className={styles.tabContent}>
          <div className={styles.protectedHeader}>
            <div className={styles.protectedStats}>
              <span className={styles.protectedStat}><strong>{protectedSummary.active}</strong> protecciones activas</span>
              <span className={styles.protectedStat}><strong>{protectedSummary.inRange}</strong> precio en rango</span>
              {protectedSummary.outside > 0 && (
                <span className={`${styles.protectedStat} ${styles.protectedStatAlert}`}>
                  ⚠ <strong>{protectedSummary.outside}</strong> fuera de rango
                </span>
              )}
            </div>
            <div className={styles.protectedActions}>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={showInactiveProtected}
                  onChange={(e) => setShowInactiveProtected(e.target.checked)}
                />
                <span>Incluir inactivas</span>
              </label>
              <button
                type="button"
                className={styles.refreshBtn}
                onClick={() => loadProtectedPools({ force: true })}
                disabled={isLoadingProtected}
              >
                {isLoadingProtected ? 'Actualizando...' : '↻ Actualizar'}
              </button>
            </div>
          </div>

          {visibleProtectedPools.length === 0 ? (
            <EmptyState
              icon="🛡️"
              title={showInactiveProtected ? 'No tienes pools protegidos.' : 'No tienes pools protegidos activos.'}
              description={showInactiveProtected
                ? "Escanea una posicion LP y usa 'Aplicar cobertura' para verlos aqui."
                : "Activa 'Ver pools sin proteccion' si quieres revisar tambien los inactivos."}
            />
          ) : (
            <div className={styles.grid}>
              {visibleProtectedPools.map((protection) => (
                <ProtectedPoolCard
                  key={protection.id}
                  protection={protection}
                  isDeactivating={deactivatingId === protection.id}
                  onDeactivate={handleDeactivate}
                  walletState={walletState}
                  onClaimFees={handleOpenAction}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {applyPool && (
        <ApplyProtectionModal
          pool={applyPool}
          accounts={accounts}
          isSubmitting={isApplyingProtection}
          onClose={() => setApplyPool(null)}
          onSubmit={handleApplyProtection}
        />
      )}

      {activeAction && (
        <PositionActionModal
          key={`${activeAction.action}-${activeAction.pool?.identifier ?? activeAction.pool?.positionIdentifier ?? 'new'}`}
          action={activeAction.action}
          pool={activeAction.pool}
          wallet={walletState}
          sendTransaction={walletConn.sendTransaction}
          waitForTransactionReceipt={walletConn.waitForTransactionReceipt}
          defaults={positionActionDefaults}
          onClose={() => setActiveAction(null)}
          onFinalized={handleClaimFinalized}
        />
      )}

      {showSmartCreate && (
        <SmartCreatePoolModal
          wallet={walletState}
          sendTransaction={walletConn.sendTransaction}
          waitForTransactionReceipt={walletConn.waitForTransactionReceipt}
          defaults={{ network, version }}
          meta={meta}
          onClose={() => setShowSmartCreate(false)}
          onFinalized={() => {
            setShowSmartCreate(false);
            refreshVisibleData().catch(() => {});
          }}
        />
      )}

      {dialog.open && (
        <ConfirmDialog
          open={dialog.open}
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          variant={dialog.variant}
          onConfirm={dialog.onConfirm}
          onCancel={dialog.onCancel}
        />
      )}

      {walletConn.needsWalletConnectSetup && (
        <WalletConnectSetupModal
          initialValue={walletConn.walletConnectProjectId}
          onSave={(id) => walletConn.setWalletConnectProjectId(id)}
          onClose={() => walletConn.dismissWalletConnectSetup()}
          onSavedConnect={() => {
            setTimeout(() => walletConn.connectWalletConnect().catch(() => {}), 50);
          }}
        />
      )}
    </div>
  );
}
