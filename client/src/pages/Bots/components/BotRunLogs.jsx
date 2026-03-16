import { useState } from 'react';
import { formatDate } from '../../../utils/formatters';
import { EmptyState } from '../../../components/shared/EmptyState';
import styles from './BotRunLogs.module.css';

const PAGE_SIZE = 20;
const ERROR_STATUSES = new Set(['error', 'paused']);

export function BotRunLogs({ runs }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);

  const query = filter.toLowerCase();
  const baseRuns = onlyErrors
    ? runs.filter((r) => ERROR_STATUSES.has(r.status))
    : runs;
  const filtered = query
    ? baseRuns.filter((r) => r.action?.toLowerCase().includes(query) || r.signal?.type?.toLowerCase().includes(query) || r.status?.toLowerCase().includes(query) || r.details?.message?.toLowerCase().includes(query))
    : baseRuns;

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3 className={styles.title}>Logs</h3>
        <span className={styles.count}>{runs.length}</span>
      </div>

      {runs.length > 0 && (
        <div className={styles.toolbar}>
          <input
            className={styles.filter}
            placeholder="Filtrar por accion, signal o error..."
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setVisibleCount(PAGE_SIZE); }}
          />
          <button
            type="button"
            className={`${styles.toggle} ${onlyErrors ? styles.toggleActive : ''}`}
            onClick={() => { setOnlyErrors((prev) => !prev); setVisibleCount(PAGE_SIZE); }}
          >
            Solo errores
          </button>
        </div>
      )}

      <div className={styles.list}>
        {visible.map((run) => (
          <div key={run.id} className={styles.item}>
            <div className={styles.itemTop}>
              <strong className={styles.action}>{run.action}</strong>
              <span className={`${styles.pill} ${statusCls(run.status)}`}>{run.status}</span>
            </div>
            <div className={styles.itemDetails}>
              <span>Signal: {run.signal?.type || '—'}</span>
              {run.details?.sizeUsd != null && <span>${Number(run.details.sizeUsd).toFixed(2)}</span>}
              {run.price != null && <span>@ {run.price}</span>}
              {run.details?.actionTaken && <span>{run.details.actionTaken}</span>}
            </div>
            {run.details?.message && <span className={styles.itemMessage}>{run.details.message}</span>}
            <span className={styles.itemDate}>{formatDate(run.createdAt)}</span>
          </div>
        ))}

        {!visible.length && (
          <EmptyState icon="&#128196;" title="Sin logs" description="Los eventos apareceran cuando el bot empiece a evaluar" />
        )}
      </div>

      {hasMore && (
        <button className={styles.loadMore} onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}>
          Cargar mas ({filtered.length - visibleCount} restantes)
        </button>
      )}
    </div>
  );
}

function statusCls(status) {
  if (status === 'active' || status === 'ok' || status === 'success') return styles.statusOk;
  if (status === 'error') return styles.statusError;
  return styles.statusNeutral;
}
