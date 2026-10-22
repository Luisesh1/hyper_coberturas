import styles from '../AlertsPage.module.css';

// Resultado de «Probar»: por activo, puntuación vs umbral, cooldown, envío a
// Telegram y las reglas que cumplen. Lo usan el editor y la hoja móvil.
export default function TestResultView({ result }) {
  return (
    <div className={styles.testResult}>
      {result.results.map((r) => (
        <div key={r.asset} className={styles.testAsset}>
          <div className={styles.testAssetHead}>
            <span className={styles.testAssetName}>{r.asset} · TF {r.lowestTimeframe}</span>
            <span className={r.wouldTrigger ? styles.scoreOk : styles.scoreNo}>
              {Number(r.score).toFixed(1)}% / {Number(r.threshold).toFixed(0)}%
              {r.wouldTrigger ? ' ✓' : ' ✗'}
            </span>
          </div>
          {r.suppressedBy === 'cooldown' && (
            <span style={{ fontSize: 11, color: '#f59e0b' }}>
              En cooldown — restan {Math.round(r.cooldownLeftMs / 1000)} s
            </span>
          )}
          {r.triggered && r.telegramSent && (
            <span style={{ fontSize: 11, color: '#22c55e' }}>📨 Enviado a Telegram</span>
          )}
          {r.rules?.map((rr, i) => (
            <div
              key={i}
              className={`${styles.testRule} ${rr.matched ? styles.testRuleMatched : styles.testRuleUnmatched}`}
            >
              {rr.matched ? '✓' : '·'} {rr.matched && rr.rule?.label ? `${rr.rule.label}: ` : ''}{rr.reason}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
