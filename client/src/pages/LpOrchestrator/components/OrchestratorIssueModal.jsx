import { useCallback, useEffect } from 'react';
import { getOrchestratorIssue } from './orchestratorIssueState';
import styles from './OrchestratorIssueModal.module.css';

export default function OrchestratorIssueModal({
  orchestrator,
  isResolving = false,
  onClose,
  onResolve,
  onShowLog,
}) {
  const issue = getOrchestratorIssue(orchestrator);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Escape' && !isResolving) onClose?.();
  }, [isResolving, onClose]);

  useEffect(() => {
    if (!issue) return undefined;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [issue, handleKeyDown]);

  if (!issue || !orchestrator) return null;

  return (
    <div className={styles.overlay} onClick={() => !isResolving && onClose?.()} role="dialog" aria-modal="true" aria-label={issue.title}>
      <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <span className={`${styles.chip} ${styles[`chip_${issue.tone}`]}`}>{issue.chipLabel}</span>
            <h3 className={styles.title}>{issue.title}</h3>
            <p className={styles.subtitle}>{orchestrator.name} · #{orchestrator.id}</p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} disabled={isResolving} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <p className={styles.summary}>{issue.summary}</p>

        {!!issue.details?.length && (
          <div className={styles.detailsGrid}>
            {issue.details.map((item) => (
              <div key={`${item.label}:${item.value}`} className={styles.detailCard}>
                <span className={styles.detailLabel}>{item.label}</span>
                <span className={styles.detailValue}>{item.value}</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.note}>
          El intento de solucion fuerza una reconciliacion del LP y luego una reevaluacion inmediata del orquestador.
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.secondaryBtn} onClick={() => onShowLog?.(orchestrator)} disabled={isResolving}>
            Ver bitacora
          </button>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={isResolving}>
            Cerrar
          </button>
          <button type="button" className={`${styles.primaryBtn} ${styles[`primaryBtn_${issue.tone}`]}`} onClick={() => onResolve?.(orchestrator)} disabled={isResolving}>
            {isResolving ? 'Resolviendo...' : issue.resolveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
