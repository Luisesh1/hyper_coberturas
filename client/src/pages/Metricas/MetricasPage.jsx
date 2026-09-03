import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { lpOrchestratorApi } from '../../services/api';
import MetricsFilterBar, { RANGE_OPTIONS } from './components/MetricsFilterBar';
import OrchestratorRow from './components/OrchestratorRow';
import PortfolioStrip from './components/PortfolioStrip';
import useSnapshotSeries from './hooks/useSnapshotSeries';
import { buildPortfolio, deriveOrchestratorRow } from './lib/portfolio';
import styles from './MetricasPage.module.css';

const POLL_INTERVAL_MS = 60_000;

const SORT_COLUMNS = [
  { key: 'name', label: 'Orquestador' },
  { key: 'capital', label: 'Capital' },
  { key: 'pnl', label: 'P&L rango' },
  { key: 'liq', label: 'A liq.' },
];

function matchesSearch(orch, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (
    orch.name?.toLowerCase().includes(t) ||
    orch.token0Symbol?.toLowerCase().includes(t) ||
    orch.token1Symbol?.toLowerCase().includes(t) ||
    orch.network?.toLowerCase().includes(t)
  );
}

const SORT_VALUES = {
  name: (row) => row.orchestrator.name?.toLowerCase() || '',
  capital: (row) => row.capitalUsd,
  pnl: (row) => row.rangePnlUsd,
  liq: (row) => row.distanceToLiqPct,
};

/** Los huecos van siempre al final, ordene como ordene el usuario. */
function compareRows(a, b, key, dir) {
  const va = SORT_VALUES[key](a);
  const vb = SORT_VALUES[key](b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
  return dir === 'asc' ? cmp : -cmp;
}

export default function MetricasPage() {
  const [orchestrators, setOrchestrators] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [rangeId, setRangeId] = useState('7d');
  const [statusFilter, setStatusFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [sort, setSort] = useState({ key: 'pnl', dir: 'desc' });

  const range = useMemo(
    () => RANGE_OPTIONS.find((r) => r.id === rangeId) || RANGE_OPTIONS[1],
    [rangeId]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const includeArchived = statusFilter !== 'active';
      const list = await lpOrchestratorApi.list({ includeArchived });
      setOrchestrators(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.message || 'Error cargando orquestadores');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const visible = useMemo(() => {
    return orchestrators
      .filter((o) => {
        if (statusFilter === 'active') return o.status === 'active';
        if (statusFilter === 'archived') return o.status === 'archived';
        return true;
      })
      .filter((o) => matchesSearch(o, search));
  }, [orchestrators, statusFilter, search]);

  const visibleIds = useMemo(() => visible.map((o) => o.id), [visible]);
  const series = useSnapshotSeries(visibleIds, range);

  const rows = useMemo(() => visible.map((orchestrator) => {
    const entry = series.byId[orchestrator.id];
    return {
      ...deriveOrchestratorRow(orchestrator, entry?.snapshots),
      error: entry?.error || null,
    };
  }), [visible, series.byId]);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareRows(a, b, sort.key, sort.dir)),
    [rows, sort]
  );

  const portfolio = useMemo(() => buildPortfolio(rows), [rows]);

  // Una fila que dejo de estar visible no puede seguir abierta por debajo.
  useEffect(() => {
    if (expandedId != null && !visibleIds.includes(expandedId)) setExpandedId(null);
  }, [visibleIds, expandedId]);

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: key === 'name' ? 'asc' : 'desc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Analitica</div>
          <h1 className={styles.title}>Metricas</h1>
          <details className={styles.explainer}>
            <summary>Cómo se calculan estas cifras</summary>
            <p className={styles.subtitle}>
              El <strong>capital</strong> es la suma en USD del valor de la wallet de
              Arbitrum (todos los tokens), la posicion LP de Uniswap y la cuenta de
              Hyperliquid vinculada — por cada orquestador. Los snapshots se capturan
              cada hora en punto.
            </p>
            <p className={styles.subtitle}>
              <strong>Δ rango</strong> mide el cambio de ese valor de mercado (incluye
              depositos y retiros). <strong>PnL total</strong> es la ganancia neta real
              acumulada: fees del LP + deriva de precio + PnL del hedge + funding − gas −
              slippage − fees de ejecucion. Pasa el cursor por encima para ver el desglose.
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

      {(rows.length > 0 || series.loading) && (
        <PortfolioStrip
          rows={rows}
          portfolio={portfolio}
          range={range}
          loading={series.loading}
        />
      )}

      {loading && !orchestrators.length && (
        <div className={styles.loading}>Cargando orquestadores…</div>
      )}

      {rows.length > 0 && (
        <section className={styles.table}>
          <div className={styles.tableHead}>
            {SORT_COLUMNS.map(({ key, label }) => (
              <Fragment key={key}>
                <button
                  type="button"
                  className={`${styles.sortBtn} ${sort.key === key ? styles.sortBtnActive : ''}`}
                  onClick={() => toggleSort(key)}
                  title={`Ordenar por ${label}`}
                >
                  {label}
                  {sort.key === key && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={sort.dir === 'asc' ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
                    </svg>
                  )}
                  <span className={styles.srOnly}>
                    {sort.key === key
                      ? (sort.dir === 'asc' ? ' (orden ascendente)' : ' (orden descendente)')
                      : ''}
                  </span>
                </button>
                {/* La columna de tendencia no se ordena: va entre el nombre y
                    el capital para que cabecera y fila compartan la rejilla. */}
                {key === 'name' && <span className={styles.headSpark}>{range?.label}</span>}
              </Fragment>
            ))}
          </div>

          {sortedRows.map((row) => (
            <OrchestratorRow
              key={row.id}
              row={row}
              range={range}
              loading={series.loading}
              expanded={expandedId === row.id}
              onToggle={() => setExpandedId((prev) => (prev === row.id ? null : row.id))}
            />
          ))}
        </section>
      )}

      {!loading && !rows.length && (
        <div className={styles.empty}>
          No hay orquestadores que coincidan con los filtros.
        </div>
      )}
    </div>
  );
}
