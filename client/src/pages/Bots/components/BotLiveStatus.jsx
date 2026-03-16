import { formatDate } from '../../../utils/formatters';
import styles from './BotLiveStatus.module.css';

export function BotLiveStatus({ bot }) {
  if (!bot) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Estado live</h3>
        <p className={styles.empty}>Selecciona un bot para ver su estado</p>
      </div>
    );
  }

  const metrics = [
    { label: 'Runtime', value: bot.runtime?.state || 'healthy', tone: bot.runtime?.state },
    { label: 'Ultima evaluacion', value: formatDate(bot.lastEvaluatedAt) },
    { label: 'Ultima vela', value: formatDate(bot.lastCandleAt) },
    { label: 'Signal', value: bot.lastSignal?.type || '—' },
    { label: 'Error', value: bot.lastError || 'Sin error', isError: !!bot.lastError },
    { label: 'Motivo pausa', value: bot.runtime?.systemPauseReason || '—', isError: !!bot.runtime?.systemPauseReason },
    { label: 'Proximo retry', value: formatDate(bot.runtime?.nextRetryAt) },
    { label: 'Ultima accion', value: bot.runtime?.lastRecoveryAction || '—' },
    { label: 'Fallos seguidos', value: String(bot.runtime?.consecutiveFailures ?? 0), tone: (bot.runtime?.consecutiveFailures ?? 0) > 0 ? 'retrying' : null },
  ];

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Estado live</h3>
      <div className={styles.grid}>
        {metrics.map((m) => (
          <div key={m.label} className={styles.metric}>
            <span className={styles.metricLabel}>{m.label}</span>
            <strong className={`${styles.metricValue} ${m.isError ? styles.error : ''} ${m.tone ? styles[`tone_${m.tone}`] : ''}`}>{m.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
