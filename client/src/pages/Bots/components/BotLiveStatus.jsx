import { formatDate, formatNumber } from '../../../utils/formatters';
import styles from './BotLiveStatus.module.css';

function computePerformance(runs = []) {
  const closedTrades = runs
    .map((run) => run?.details?.closedTrade)
    .filter((trade) => Number.isFinite(Number(trade?.pnl)));

  const tradeCount = closedTrades.length;
  const netPnl = closedTrades.reduce((acc, trade) => acc + Number(trade.pnl || 0), 0);
  const wins = closedTrades.filter((trade) => Number(trade.pnl || 0) >= 0).length;
  const bestTrade = closedTrades.reduce((acc, trade) => (
    acc == null ? Number(trade.pnl) : Math.max(acc, Number(trade.pnl))
  ), null);
  const worstTrade = closedTrades.reduce((acc, trade) => (
    acc == null ? Number(trade.pnl) : Math.min(acc, Number(trade.pnl))
  ), null);

  return {
    tradeCount,
    winRate: tradeCount ? Number(((wins / tradeCount) * 100).toFixed(2)) : null,
    netPnl: tradeCount ? Number(netPnl.toFixed(2)) : null,
    avgTrade: tradeCount ? Number((netPnl / tradeCount).toFixed(2)) : null,
    bestTrade: tradeCount ? bestTrade : null,
    worstTrade: tradeCount ? worstTrade : null,
  };
}

function formatSignedUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}$${formatNumber(Math.abs(numeric), 2)}`;
}

export function BotLiveStatus({ bot, runs = [] }) {
  if (!bot) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Estado live</h3>
        <p className={styles.empty}>Selecciona un bot para ver su estado</p>
      </div>
    );
  }

  const performance = computePerformance(runs);
  const pnlTone = performance.netPnl > 0 ? 'healthy' : performance.netPnl < 0 ? 'negative' : null;
  const winRateTone = performance.winRate >= 50 ? 'healthy' : performance.winRate != null ? 'negative' : null;
  const metrics = [
    { label: 'Runtime', value: bot.runtime?.state || 'healthy', tone: bot.runtime?.state },
    { label: 'PnL real', value: formatSignedUsd(performance.netPnl), tone: pnlTone },
    { label: 'Win rate real', value: performance.winRate != null ? `${formatNumber(performance.winRate, 2)}%` : '—', tone: winRateTone },
    { label: 'Trades cerrados', value: String(performance.tradeCount || 0) },
    { label: 'Prom. trade', value: formatSignedUsd(performance.avgTrade) },
    { label: 'Mejor / peor', value: performance.tradeCount ? `${formatSignedUsd(performance.bestTrade)} / ${formatSignedUsd(performance.worstTrade)}` : '—' },
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
