import { getExplorerLink } from '../../utils/pool-helpers';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso de firma: progreso de transacciones mientras el usuario firma con la wallet.
 */
export default function StepSigning({
  prepareData,
  completedTxIndex,
  currentTxIndex,
  txHashes,
  explorerUrl,
  loadingMessage,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.kicker}>
          Transacción {Math.min(currentTxIndex + 1, prepareData?.txPlan?.length || 0)} de {prepareData?.txPlan?.length || 0}
        </span>
      </div>
      <div className={styles.txProgressList}>
        {(prepareData?.txPlan || []).map((tx, index) => {
          const label = tx?.label || `Transacción ${index + 1}`;
          const isDone = index <= completedTxIndex;
          const isActive = index === currentTxIndex && !isDone;
          const hash = txHashes[index] || null;
          const txLink = hash && explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
          return (
            <div
              key={`${tx?.kind}-${index}`}
              className={`${styles.txStepItem} ${isDone ? styles.txStepDone : ''} ${isActive ? styles.txStepActive : ''} ${!isDone && !isActive ? styles.txStepPending : ''}`}
            >
              <span className={styles.txStepIcon}>
                {isDone ? '✓' : isActive ? '' : '○'}
              </span>
              <span className={styles.txStepLabel}>{label}</span>
              {isDone && hash && (
                <span className={styles.txStepHash}>
                  {txLink
                    ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                    : <span>{hash.slice(0, 10)}…</span>
                  }
                </span>
              )}
              {isActive && <span className={styles.txStepSpinner} />}
            </div>
          );
        })}
      </div>
      <div className={styles.loading}>
        <p>{loadingMessage || 'Firma cada transacción en tu wallet...'}</p>
      </div>
    </section>
  );
}
