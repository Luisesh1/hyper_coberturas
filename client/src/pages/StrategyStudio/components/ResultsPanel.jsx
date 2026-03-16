import { useState } from 'react';
import { EmptyState } from '../../../components/shared/EmptyState';
import styles from './ResultsPanel.module.css';

export function ResultsPanel({ validationResult, backtestResult, selectedStrategy }) {
  const [tab, setTab] = useState('validation');
  const backtest = backtestResult || selectedStrategy?.latestBacktest;
  const metrics = backtestResult?.metrics || selectedStrategy?.latestBacktest?.summary;

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'validation' ? styles.tabActive : ''}`}
          onClick={() => setTab('validation')}
        >
          Validacion
          {validationResult && <span className={styles.tabBadge}>{validationResult.signal?.type || 'hold'}</span>}
        </button>
        <button
          className={`${styles.tab} ${tab === 'backtest' ? styles.tabActive : ''}`}
          onClick={() => setTab('backtest')}
        >
          Backtest
          {metrics && <span className={styles.tabBadge}>{metrics.trades ?? 0} trades</span>}
        </button>
      </div>

      {tab === 'validation' && (
        <div className={styles.content}>
          {validationResult ? (
            <>
              <div className={styles.metricsGrid}>
                <div className={styles.metric}><span>Asset</span><strong>{validationResult.asset}</strong></div>
                <div className={styles.metric}><span>Timeframe</span><strong>{validationResult.timeframe}</strong></div>
                <div className={styles.metric}><span>Signal</span><strong className={signalClass(validationResult.signal?.type)}>{validationResult.signal?.type || 'hold'}</strong></div>
                <div className={styles.metric}><span>Velas</span><strong>{validationResult.diagnostics?.candles || 0}</strong></div>
              </div>
              <pre className={styles.json}>{JSON.stringify(validationResult.signal, null, 2)}</pre>
            </>
          ) : (
            <EmptyState icon="&#9654;" title="Sin validacion" description="Ejecuta una validacion para ver la signal resultante" />
          )}
        </div>
      )}

      {tab === 'backtest' && (
        <div className={styles.content}>
          {metrics ? (
            <>
              <div className={styles.metricsGrid}>
                {Object.entries(metrics).map(([key, value]) => (
                  <div key={key} className={styles.metric}>
                    <span>{key}</span>
                    <strong>{String(value)}</strong>
                  </div>
                ))}
              </div>
              {backtestResult?.trades?.length > 0 && (
                <div className={styles.trades}>
                  <h4 className={styles.tradesTitle}>Ultimos trades</h4>
                  {backtestResult.trades.slice(0, 10).map((trade, i) => (
                    <div key={i} className={styles.tradeRow}>
                      <span className={trade.side === 'long' ? styles.long : styles.short}>{trade.side.toUpperCase()}</span>
                      <span className={styles.tradePrice}>{trade.entryPrice} → {trade.exitPrice}</span>
                      <span className={parseFloat(trade.pnl) >= 0 ? styles.long : styles.short}>{trade.pnl}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyState icon="&#128202;" title="Sin backtest" description="Ejecuta un backtest para ver metricas y trades" />
          )}
        </div>
      )}
    </div>
  );
}

function signalClass(type) {
  if (type === 'long') return styles.long;
  if (type === 'short') return styles.short;
  return '';
}
