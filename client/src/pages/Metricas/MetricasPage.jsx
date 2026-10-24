import { useCallback, useEffect, useMemo, useState } from 'react';
import { walletMetricsApi } from '../../services/api';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import MetricsFilterBar, { RANGE_OPTIONS } from './components/MetricsFilterBar';
import PortfolioStrip from './components/PortfolioStrip';
import WalletRow from './components/WalletRow';
import useWalletSeries from './hooks/useWalletSeries';
import { aggregateChange, walletChange } from './lib/walletSeries';
import styles from './MetricasPage.module.css';

const POLL_INTERVAL_MS = 60_000;
const EMPTY = [];

export default function MetricasPage() {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [rangeId, setRangeId] = useState('7d');
  const [statusFilter, setStatusFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const range = useMemo(
    () => RANGE_OPTIONS.find((r) => r.id === rangeId) || RANGE_OPTIONS[1],
    [rangeId]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await walletMetricsApi.list({ includeArchived: true });
      setWallets(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.message || 'Error cargando wallets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useVisibleInterval(refresh, POLL_INTERVAL_MS);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return wallets
      .filter((w) => w.status === statusFilter)
      .filter((w) => !term || w.address.includes(term) || w.label?.toLowerCase().includes(term));
  }, [wallets, statusFilter, search]);

  const visibleIds = useMemo(() => visible.map((w) => w.id), [visible]);
  // Una captura nueva en cualquier wallet visible recarga la serie.
  const reloadKey = useMemo(
    () => visible.map((w) => w.latest?.capturedAt || 0).join(','),
    [visible]
  );
  const series = useWalletSeries(visibleIds, range, reloadKey);

  const changes = useMemo(
    () => Object.fromEntries(visibleIds.map((id) => [id, walletChange(series.byId[id])])),
    [visibleIds, series.byId]
  );
  const aggregate = useMemo(
    () => aggregateChange(Object.fromEntries(visibleIds.map((id) => [id, series.byId[id] || []]))),
    [visibleIds, series.byId]
  );

  const sorted = useMemo(
    () => [...visible].sort((a, b) => (b.latest?.totals.totalUsd ?? -1) - (a.latest?.totals.totalUsd ?? -1)),
    [visible]
  );

  useEffect(() => {
    if (expandedId != null && !visibleIds.includes(expandedId)) setExpandedId(null);
  }, [visibleIds, expandedId]);

  const archivedCount = wallets.filter((w) => w.status === 'archived').length;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Analitica</div>
          <h1 className={styles.title}>Metricas</h1>
          <details className={styles.explainer}>
            <summary>Cómo se calculan estas cifras</summary>
            <p className={styles.subtitle}>
              Se sigue cada <strong>wallet</strong> con la que se ha creado un orquestador,
              aunque ese orquestador ya esté cerrado, hasta que archives la wallet. Cada
              hora en punto se suma su valor en USD: tokens en todas las redes, todas sus
              posiciones LP de Uniswap y la cuenta de Hyperliquid de la misma dirección
              (perps + spot).
            </p>
            <p className={styles.subtitle}>
              Es valor bruto de mercado: depósitos y retiros se ven como saltos. El cambio
              del total es la suma del cambio de cada wallet en el rango, así que una wallet
              que empieza a seguirse a mitad de rango no cuenta como ganancia. Si una fuente
              no responde se usa su último valor y el punto se marca como parcial.
            </p>
          </details>
        </div>
      </div>

      <MetricsFilterBar
        range={rangeId}
        onRangeChange={setRangeId}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        search={search}
        onSearchChange={setSearch}
      />

      {error && <div className={styles.empty}>Error: {error}</div>}

      {visible.length > 0 && (
        <PortfolioStrip wallets={visible} aggregate={aggregate} range={range} loading={series.loading} />
      )}

      {loading && !wallets.length && <div className={styles.loading}>Cargando wallets…</div>}

      {sorted.length > 0 && (
        <section className={styles.table} aria-label="Wallets">
          <div className={styles.tableHead} aria-hidden="true">
            <span>Wallet</span>
            <span className={styles.headSpark}>{range.label}</span>
            <span className={styles.headNum}>Valor</span>
            <span className={styles.headNum}>Cambio</span>
          </div>
          {sorted.map((wallet) => (
            <WalletRow
              key={wallet.id}
              wallet={wallet}
              points={series.byId[wallet.id] || EMPTY}
              change={changes[wallet.id]}
              range={range}
              loading={loading || series.loading}
              expanded={expandedId === wallet.id}
              onToggle={() => setExpandedId((prev) => (prev === wallet.id ? null : wallet.id))}
              onStatusChange={() => { setExpandedId(null); refresh(); }}
            />
          ))}
        </section>
      )}

      {!loading && !error && !visible.length && (
        <div className={styles.empty}>
          {statusFilter === 'archived'
            ? 'No hay wallets archivadas.'
            : (wallets.length
              ? 'Ninguna wallet activa coincide con la búsqueda.'
              : 'Aún no hay wallets: se empiezan a seguir al crear un orquestador.')}
          {statusFilter === 'active' && archivedCount > 0 && !search && (
            <span className={styles.emptyHint}> {archivedCount} archivada{archivedCount === 1 ? '' : 's'}.</span>
          )}
        </div>
      )}
    </div>
  );
}
