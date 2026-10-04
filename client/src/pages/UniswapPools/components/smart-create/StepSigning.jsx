import { useEffect, useState } from 'react';
import { getExplorerLink } from '../../utils/pool-helpers';

// Margen para que la wallet muestre la firma antes de ofrecer cortar la espera.
const CANCEL_WAIT_AFTER_MS = 20_000;
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
  awaitingWallet = false,
  onCancelWait = null,
}) {
  const [canCancel, setCanCancel] = useState(false);
  useEffect(() => {
    setCanCancel(false);
    if (!awaitingWallet || !onCancelWait) return undefined;
    const timer = setTimeout(() => setCanCancel(true), CANCEL_WAIT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [awaitingWallet, onCancelWait, currentTxIndex]);

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
      {canCancel && (
        <div className={styles.buttonGroup}>
          <p className={styles.hint}>
            ¿Ya firmaste o rechazaste y no avanza? La wallet puede no haber respondido.
            Antes de cortar se comprueba si la transacción llegó a la cadena.
          </p>
          <button type="button" className={styles.secondaryBtn} onClick={onCancelWait}>
            Cancelar espera
          </button>
        </div>
      )}
    </section>
  );
}
