import styles from '../UnifiedLpWizard.module.css';

/**
 * Recomendación de rango ATR para ETH/WETH + USDC.
 *
 * Se renderiza *antes* del selector de rango: es una sugerencia sobre la que
 * decidir, y colocarla debajo dejaba la casilla que bloquea "Continuar a
 * fondeo" por debajo del propio botón.
 */
export default function EthUsdcRangeCard({
  recommendation,
  applied,
  confirmed,
  onConfirmedChange,
  blocked,
  onApply,
}) {
  if (!recommendation) return null;

  const needsConfirmation = recommendation.requiresConfirmation && applied;
  const tone = recommendation.requiresConfirmation ? styles.cardWarn : styles.cardTeal;

  return (
    <section className={`${styles.card} ${tone}`}>
      <div className={styles.cardHead}>
        <h4 className={styles.cardTitle}>Rango recomendado ETH/USDC</h4>
        {applied && <span className={styles.markOk}>✓ aplicado</span>}
      </div>

      <div className={styles.kv}>
        <span>Semiancho ATR</span>
        <strong>±{recommendation.halfWidthPct}%</strong>
      </div>
      <div className={styles.kv}>
        <span>Ancho total</span>
        <strong>{recommendation.widthPct}%</strong>
      </div>

      <p className={styles.hint}>
        Se calcula como máximo entre ±4,2% y tres ATR de 14 horas. Al aplicarlo se selecciona
        <strong> Personalizado</strong>, para conservar exactamente el rango revisado.
      </p>

      <button type="button" className={styles.btn} onClick={onApply}>
        {applied ? `Volver a aplicar ±${recommendation.halfWidthPct}%` : `Aplicar rango ±${recommendation.halfWidthPct}%`}
      </button>

      {needsConfirmation && (
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
          />
          Confirmo el rango amplio ({recommendation.widthPct}% total).
        </label>
      )}

      {needsConfirmation && blocked && !confirmed && (
        <p className={styles.errorText}>Confirma este rango personalizado antes de continuar a fondeo.</p>
      )}
    </section>
  );
}
