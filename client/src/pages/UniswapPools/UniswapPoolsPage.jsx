import { useCallback, useEffect, useMemo, useState } from 'react';
import { settingsApi, uniswapApi } from '../../services/api';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { useConfirmAction } from '../../hooks/useConfirmAction';
import { mergeResultProtections } from './utils/pool-sorting';
import { getPoolSortScore } from './utils/pool-sorting';
import { sortProtectedPools } from './utils/pool-sorting';
import ScannerBar from './components/ScannerBar';
import ResultsToolbar from './components/ResultsToolbar';
import PoolCard from './components/PoolCard';
import ProtectedPoolCard from './components/ProtectedPoolCard';
import ApplyProtectionModal from './components/ApplyProtectionModal';
import SkeletonCard from './components/SkeletonCard';
import styles from './UniswapPoolsPage.module.css';

const PROTECTED_POOLS_REFRESH_INTERVAL_MS = 600000;

export default function UniswapPoolsPage() {
  const [meta, setMeta] = useState(null);
  const [wallet, setWallet] = useState('');
  const [network, setNetwork] = useState('ethereum');
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
  const { dialog, confirm } = useConfirmAction();

  const loadProtectedPools = useCallback(async () => {
    setIsLoadingProtected(true);
    try {
      const data = await uniswapApi.listProtectedPools();
      setProtectedPools(data);
      setProtectedRefreshedAt(Date.now());
      setResult((prev) => mergeResultProtections(prev, data));
    } catch (err) {
      setError(err.message);
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
        setMeta(metaData);
        setHasApiKey(etherscanData?.hasApiKey || false);
        setAccounts(accountsData || []);
        setProtectedPools(protectedData || []);
        setProtectedRefreshedAt(Date.now());
        if (walletData?.address) setWallet(walletData.address);
      } catch (err) {
        setError(err.message);
      }
    }
    loadInitial().catch(() => {});
  }, []);

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
      eligible: searched.filter((p) => p.protectionCandidate?.eligible).length,
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
        if (resultFilter === 'eligible' && !pool.protectionCandidate?.eligible) return false;
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
    if (!pool?.protectionCandidate?.eligible) {
      setError(pool?.protectionCandidate?.reason || 'Este pool no es elegible para proteccion automatica.');
      return;
    }
    setApplyPool(pool);
  };

  const handleApplyProtection = async ({ pool, accountId, leverage, configuredNotionalUsd, valueMultiplier, stopLossDifferencePct }) => {
    setIsApplyingProtection(true);
    setError('');
    try {
      await uniswapApi.createProtectedPool({ pool, accountId, leverage, configuredNotionalUsd, valueMultiplier, stopLossDifferencePct });
      setApplyPool(null);
      await loadProtectedPools();
      setActiveTab('protected');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsApplyingProtection(false);
    }
  };

  const handleDeactivate = async (protection) => {
    const ok = await confirm({
      title: 'Desactivar proteccion',
      message: `Se cancelaran las dos coberturas ligadas a ${protection.token0Symbol}/${protection.token1Symbol}.`,
      confirmLabel: 'Desactivar proteccion',
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

      {!hasApiKey && (
        <div className={styles.notice}>
          Configura tu API key de Etherscan en Config antes de usar el scanner.
        </div>
      )}
      {!accounts.length && (
        <div className={styles.notice}>
          No hay cuentas de Hyperliquid configuradas. Puedes escanear pools, pero no activar protecciones hasta agregar una cuenta.
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
          Resultados
          {result?.count > 0 && <span className={styles.tabCount}>{filteredPools.length}</span>}
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'protected' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('protected')}
        >
          Protegidos
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
            <div className={styles.empty}>
              <span className={styles.emptyTitle}>Listo para escanear una wallet</span>
              <p className={styles.emptyText}>
                Usa la barra superior para buscar posiciones LP de Uniswap y encontrar pools listos para proteger.
              </p>
            </div>
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
                <div className={styles.empty}>
                  <span className={styles.emptyTitle}>
                    {result.count === 0
                      ? isLpModeSelection
                        ? 'No se encontraron posiciones LP activas.'
                        : 'No se encontraron pools con liquidez relevante.'
                      : 'Ningun pool coincide con los filtros actuales.'}
                  </span>
                  <p className={styles.emptyText}>
                    {result.count === 0
                      ? 'Prueba con otra red, version o wallet.'
                      : 'Ajusta la busqueda, el filtro o el orden para explorar otros resultados.'}
                  </p>
                </div>
              ) : (
                <div className={styles.grid}>
                  {filteredPools.map((pool) => (
                    <PoolCard
                      key={pool.id}
                      pool={pool}
                      hasAccounts={accounts.length > 0}
                      onApplyProtection={handleOpenApply}
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
              <span className={styles.protectedStat}><strong>{protectedSummary.active}</strong> Activas</span>
              <span className={styles.protectedStat}><strong>{protectedSummary.inRange}</strong> En rango</span>
              {protectedSummary.outside > 0 && (
                <span className={`${styles.protectedStat} ${styles.protectedStatAlert}`}>
                  <strong>{protectedSummary.outside}</strong> Fuera
                </span>
              )}
            </div>
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => loadProtectedPools()}
              disabled={isLoadingProtected}
            >
              {isLoadingProtected ? 'Actualizando...' : 'Refrescar'}
            </button>
          </div>

          {protectedPools.length === 0 ? (
            <div className={styles.empty}>
              <span className={styles.emptyTitle}>No tienes pools protegidos todavia.</span>
              <p className={styles.emptyText}>Escanea una posicion LP y usa "Aplicar cobertura".</p>
            </div>
          ) : (
            <div className={styles.grid}>
              {orderedProtectedPools.map((protection) => (
                <ProtectedPoolCard
                  key={protection.id}
                  protection={protection}
                  isDeactivating={deactivatingId === protection.id}
                  onDeactivate={handleDeactivate}
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
    </div>
  );
}
