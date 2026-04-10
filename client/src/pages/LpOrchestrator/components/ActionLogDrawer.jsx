import { useEffect, useState } from 'react';
import { lpOrchestratorApi } from '../../../services/api';
import { formatRelativeTimestamp, formatUsd } from '../../UniswapPools/utils/pool-formatters';
import styles from './ActionLogDrawer.module.css';

const KIND_LABELS = {
  decision: { label: 'Decisión', icon: '🧠', tone: 'info' },
  tx_started: { label: 'Tx iniciada', icon: '📝', tone: 'info' },
  tx_finalized: { label: 'Tx finalizada', icon: '✅', tone: 'ok' },
  verification: { label: 'Verificación', icon: '🔍', tone: 'info' },
  recovery: { label: 'Recuperación', icon: '🩹', tone: 'warn' },
  notification: { label: 'Notificación', icon: '🔔', tone: 'info' },
  accounting_snapshot: { label: 'Snapshot contabilidad', icon: '💰', tone: 'info' },
  attach_lp: { label: 'LP adjuntado', icon: '🎯', tone: 'ok' },
  kill_lp: { label: 'LP cerrado', icon: '🔪', tone: 'warn' },
  archive: { label: 'Archivado', icon: '📦', tone: 'muted' },
};

const DECISION_LABELS = {
  hold: { label: 'En espera', tone: 'muted' },
  recommend_rebalance: { label: 'Recomienda rebalance', tone: 'warn' },
  urgent_adjust: { label: 'AJUSTE URGENTE', tone: 'urgent' },
  recommend_collect_fees: { label: 'Cobrar fees', tone: 'info' },
};

export default function ActionLogDrawer({ orchestrator, onClose }) {
  const [entries, setEntries] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!orchestrator) return;
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const data = await lpOrchestratorApi.getActionLog(orchestrator.id, { limit: 200 });
        if (!cancelled) setEntries(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'No se pudo cargar la bitácora.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [orchestrator]);

  if (!orchestrator) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Bitácora</span>
            <h2 className={styles.title}>{orchestrator.name}</h2>
            <p className={styles.subtitle}>
              {entries.length} eventos · más reciente arriba
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {isLoading && entries.length === 0 && (
            <div className={styles.loading}>Cargando bitácora…</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
          {!isLoading && entries.length === 0 && !error && (
            <div className={styles.empty}>
              Aún no hay eventos registrados.
              <br />
              <span className={styles.muted}>Las decisiones del motor aparecerán aquí cada 30 s.</span>
            </div>
          )}

          {entries.map((entry) => (
            <LogEntry key={entry.id} entry={entry} />
          ))}
        </div>
      </aside>
    </div>
  );
}

function LogEntry({ entry }) {
  const kind = KIND_LABELS[entry.kind] || { label: entry.kind, icon: '•', tone: 'muted' };
  const decision = entry.decision ? DECISION_LABELS[entry.decision] || { label: entry.decision, tone: 'muted' } : null;

  return (
    <div className={`${styles.entry} ${styles[`tone_${decision?.tone || kind.tone}`]}`}>
      <div className={styles.entryHeader}>
        <span className={styles.entryIcon}>{kind.icon}</span>
        <div className={styles.entryHeading}>
          <span className={styles.entryKind}>
            {kind.label}
            {decision && <span className={styles.entryDecision}> · {decision.label}</span>}
          </span>
          <span className={styles.entryTime}>{formatRelativeTimestamp(entry.createdAt)}</span>
        </div>
      </div>

      {entry.reason && (
        <div className={styles.entryReason}>
          <span className={styles.muted}>razón:</span> {entry.reason}
        </div>
      )}

      {entry.action && (
        <div className={styles.entryAction}>
          <span className={styles.muted}>acción:</span> <code>{entry.action}</code>
        </div>
      )}

      {(entry.estimatedCostUsd != null || entry.estimatedRewardUsd != null || entry.realizedCostUsd != null) && (
        <div className={styles.entryNumbers}>
          {entry.currentPrice != null && (
            <Cell label="Precio" value={Number(entry.currentPrice).toFixed(4)} />
          )}
          {entry.estimatedCostUsd != null && (
            <Cell label="Coste est." value={formatUsd(entry.estimatedCostUsd)} />
          )}
          {entry.estimatedRewardUsd != null && (
            <Cell label="Ganancias" value={formatUsd(entry.estimatedRewardUsd)} />
          )}
          {entry.costToRewardRatio != null && (
            <Cell label="Ratio c/r" value={Number(entry.costToRewardRatio).toFixed(3)} />
          )}
          {entry.realizedCostUsd != null && (
            <Cell label="Coste real" value={formatUsd(entry.realizedCostUsd)} />
          )}
        </div>
      )}

      {entry.verificationStatus && (
        <div className={styles.entryVerification}>
          Verificación: <strong>{entry.verificationStatus}</strong>
          {entry.driftDetails && Array.isArray(entry.driftDetails) && entry.driftDetails.length > 0 && (
            <ul className={styles.drifts}>
              {entry.driftDetails.map((d, i) => (
                <li key={i}>
                  <code>{d.field || '?'}</code>: {d.kind}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value }) {
  return (
    <div className={styles.cell}>
      <span className={styles.cellLabel}>{label}</span>
      <span className={styles.cellValue}>{value}</span>
    </div>
  );
}
