import { getExplorerLink } from '../../utils/pool-helpers';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso final: confirmación de la creación exitosa del LP.
 */
export default function StepDone({
  txHashes,
  prepareData,
  explorerUrl,
  onClose,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.success}>
        <div className={styles.checkmark}>✓</div>
        <p>Posición LP creada correctamente.</p>
      </div>
      {txHashes.length > 0 && (
        <div className={styles.txList}>
          <h4>Transacciones confirmadas ({txHashes.length})</h4>
          {txHashes.map((hash, index) => {
            const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
            const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
            return (
              <div key={hash} className={styles.txItem}>
                <span className={styles.txLabel}>
                  {label}
                  {' — '}
                  {txLink
                    ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 14)}…{hash.slice(-6)}</a>
                    : <span className={styles.hint}>{hash.slice(0, 14)}…{hash.slice(-6)}</span>
                  }
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.buttonGroup}>
        <button type="button" className={styles.primaryBtn} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </section>
  );
}
