import { getExplorerLink } from '../../utils/pool-helpers';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso de error: muestra detalles del fallo y acciones de recuperación.
 */
export default function StepError({
  error,
  completedTxIndex,
  txHashes,
  prepareData,
  explorerUrl,
  failedTxLabel,
  handleReset,
  onClose,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.errorBox}>
        <p>{error || 'Ocurrió un error en el wizard de creación LP.'}</p>

        {completedTxIndex >= 0 && txHashes.length > 0 && (
          <div className={styles.txList}>
            <h4>Transacciones completadas exitosamente</h4>
            {txHashes.map((hash, index) => {
              const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
              const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
              return (
                <div key={hash} className={styles.txItem}>
                  <span className={styles.txLabel}>
                    {label}
                    {' — '}
                    {txLink
                      ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                      : <span>{hash.slice(0, 10)}…</span>
                    }
                  </span>
                </div>
              );
            })}
            <p className={styles.hint}>
              El plan ya quedó parcialmente ejecutado on-chain. Antes de volver a intentarlo, revisa estas transacciones y genera un plan nuevo desde estado fresco.
            </p>
          </div>
        )}

        {failedTxLabel && (
          <p className={styles.hint}>Transacción fallida: {failedTxLabel}</p>
        )}

        <div className={styles.buttonGroup}>
          <button type="button" className={styles.secondaryBtn} onClick={handleReset}>
            Empezar de nuevo
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </section>
  );
}
