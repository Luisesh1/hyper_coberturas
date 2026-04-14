import { useCallback, useEffect, useMemo, useState } from 'react';
import { lpOrchestratorApi } from '../../services/api';
import MetricsFilterBar, { RANGE_OPTIONS } from './components/MetricsFilterBar';
import OrchestratorMetricChart from './components/OrchestratorMetricChart';
import styles from './MetricasPage.module.css';

const POLL_INTERVAL_MS = 60_000;

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

export default function MetricasPage() {
  const [orchestrators, setOrchestrators] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [rangeId, setRangeId] = useState('7d');
  const [statusFilter, setStatusFilter] = useState('active');
  const [search, setSearch] = useState('');

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

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Analitica</div>
          <h1 className={styles.title}>Metricas</h1>
          <p className={styles.subtitle}>
            Suma en USD del valor de la wallet de Arbitrum (todos los tokens),
            la posicion LP de Uniswap y la cuenta de Hyperliquid vinculada — por cada
            orquestador. Los snapshots se capturan cada hora en punto.
          </p>
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

      {loading && !orchestrators.length && (
        <div className={styles.loading}>Cargando orquestadores…</div>
      )}
      {error && <div className={styles.empty}>Error: {error}</div>}

      <div className={styles.grid}>
        {visible.map((orch) => (
          <OrchestratorMetricChart
            key={orch.id}
            orchestrator={orch}
            range={range}
          />
        ))}
        {!loading && !visible.length && (
          <div className={styles.empty}>
            No hay orquestadores que coincidan con los filtros.
          </div>
        )}
      </div>
    </div>
  );
}
