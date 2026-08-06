import ProtectionFormFields from '../ProtectionFormFields';
import styles from '../UnifiedLpWizard.module.css';

/**
 * Marca de un check del pre-flight. `ok === null` significa "no se pudo
 * evaluar", que no es lo mismo que "falla": mostrarlos igual haría creer al
 * usuario que hay más cosas rotas de las que hay.
 */
function CheckMark({ ok }) {
  if (ok === true) return <span className={styles.markOk}>✓</span>;
  if (ok === false) return <span className={styles.markNo}>✕</span>;
  return <span className={styles.markPending}>·</span>;
}

export default function StepProtection({
  protection,
  setProtection,
  accounts,
  lpWalletAddress,
  defaultLeverage = '5',
  capitalUsd,
  rangeWidthPct,
  preflight,
  preflightBusy,
  onRunPreflight,
}) {
  const disabled = protection?.enabled === false;

  return (
    <div className={styles.stepBody}>
      <ProtectionFormFields
        value={protection}
        onChange={(next) => setProtection(next)}
        accounts={accounts}
        lpWalletAddress={lpWalletAddress}
        defaultLeverage={defaultLeverage}
        initialUsd={capitalUsd}
        rangeWidthPct={rangeWidthPct}
      />

      {!disabled && (
        <section className={`${styles.card} ${preflight?.ok === false ? styles.cardErr : ''} ${preflight?.ok ? styles.cardOk : ''}`}>
          <header className={styles.cardHead}>
            <h4 className={styles.cardTitle}>Verificación previa</h4>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={onRunPreflight}
              disabled={preflightBusy}
            >
              {preflightBusy ? 'Comprobando…' : 'Comprobar'}
            </button>
          </header>

          {!preflight && !preflightBusy && (
            <p className={styles.hint}>
              Se valida la cobertura contra Hyperliquid <strong>antes</strong> de firmar
              nada on-chain. Si algo no cuadra, es gratis corregirlo aquí.
            </p>
          )}

          {preflight?.checks?.length > 0 && (
            <ul className={styles.checkList}>
              {preflight.checks.map((check) => (
                <li key={check.id} className={styles.checkItem}>
                  <CheckMark ok={check.ok} />
                  <div>
                    <span className={styles.checkLabel}>{check.label}</span>
                    {check.detail && <span className={styles.checkDetail}>{check.detail}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {preflight?.blockingReason && (
            <p className={styles.errorText}>{preflight.blockingReason}</p>
          )}
        </section>
      )}

      {disabled && (
        <p className={styles.hint}>
          Sin cobertura, el orquestador seguirá y contabilizará el LP, pero la
          exposición al token volátil queda sin cubrir.
        </p>
      )}
    </div>
  );
}
