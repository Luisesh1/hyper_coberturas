import styles from '../UnifiedLpWizard.module.css';

/**
 * Pantalla terminal de la saga. El caso interesante es `compensated`: lo
 * reversible ya se deshizo, y lo único que queda vivo es el LP minado. Se
 * presenta con sus tres salidas explícitas en vez de un error de texto.
 */
export default function StepOutcome({
  outcome,
  onClose,
  onRetryProtection,
  onKeepWithoutProtection,
  onCloseLp,
}) {
  if (outcome?.status === 'completed') {
    return (
      <div className={styles.stepBody}>
        <section className={`${styles.card} ${styles.cardOk}`}>
          <h4 className={styles.cardTitle}>Listo</h4>
          <p className={styles.hint}>
            {outcome.orchestrator
              ? 'El LP está creado, la cobertura abierta y el orquestador vinculado.'
              : 'La posición se creó correctamente.'}
          </p>
        </section>
        <div className={styles.actionsRow}>
          <button type="button" className={styles.btnPrimary} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    );
  }

  if (outcome?.status === 'blocked') {
    return (
      <div className={styles.stepBody}>
        <section className={`${styles.card} ${styles.cardErr}`}>
          <h4 className={styles.cardTitle}>No se firmó nada</h4>
          <p className={styles.hint}>{outcome.reason}</p>
        </section>
        <div className={styles.actionsRow}>
          <button type="button" className={styles.btn} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    );
  }

  const lp = outcome?.survivingLp;

  return (
    <div className={styles.stepBody}>
      <section className={`${styles.card} ${styles.cardErr}`}>
        <h4 className={styles.cardTitle}>La creación no se pudo completar</h4>
        <p className={styles.errorText}>{outcome?.reason}</p>
      </section>

      {outcome?.compensations?.length > 0 && (
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>Qué se revirtió automáticamente</h4>
          <ul className={styles.checkList}>
            {outcome.compensations.map((step) => (
              <li key={step.id} className={styles.checkItem}>
                <span className={step.ok ? styles.markOk : styles.markNo}>{step.ok ? '↩' : '✕'}</span>
                <span className={styles.checkDetail}>{step.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outcome?.needsManualReview && (
        <p className={styles.errorText}>
          Parte de la compensación falló. Revisá la cuenta en Hyperliquid: puede
          haber quedado una posición abierta.
        </p>
      )}

      {lp?.positionIdentifier && (
        <section className={`${styles.card} ${styles.cardWarn}`}>
          <h4 className={styles.cardTitle}>Qué sigue vivo</h4>
          <p className={styles.lpTitle}>
            LP #{lp.positionIdentifier}
            {lp.token0Symbol && ` — ${lp.token0Symbol}/${lp.token1Symbol}`}
          </p>
          {lp.valueUsd != null && (
            <p className={styles.hint}>${lp.valueUsd} desplegados · sin cobertura</p>
          )}
          <p className={styles.hint}>
            Está minado on-chain y no se puede deshacer sin gastar gas y
            cristalizar el impermanent loss. Por eso la decisión es tuya.
          </p>
        </section>
      )}

      {!lp?.positionIdentifier && lp?.txHashes?.length > 0 && (
        <section className={`${styles.card} ${styles.cardWarn}`}>
          <h4 className={styles.cardTitle}>Transacciones sin conciliar</h4>
          <p className={styles.hint}>
            No se pudo resolver el identificador de la posición. Estas son las
            transacciones firmadas — buscá el LP con «Adoptar LP existente».
          </p>
          <ul className={styles.txList}>
            {lp.txHashes.map((hash) => <li key={hash} className={styles.txHash}>{hash}</li>)}
          </ul>
        </section>
      )}

      <div className={styles.actionsRow}>
        {lp?.positionIdentifier && (
          <>
            <button type="button" className={styles.btnDanger} onClick={() => onCloseLp?.(lp)}>
              Cerrar el LP
            </button>
            <button type="button" className={styles.btn} onClick={onRetryProtection}>
              Reintentar la cobertura
            </button>
            <button type="button" className={styles.btnGhost} onClick={() => onKeepWithoutProtection?.(lp)}>
              Conservarlo sin cobertura
            </button>
          </>
        )}
        {!lp?.positionIdentifier && (
          <button type="button" className={styles.btn} onClick={onClose}>Cerrar</button>
        )}
      </div>
    </div>
  );
}
