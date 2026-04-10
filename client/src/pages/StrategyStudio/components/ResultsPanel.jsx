import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../../../components/shared/EmptyState';
import { formatDate, formatNumber } from '../../../utils/formatters';
import styles from './ResultsPanel.module.css';

const SUMMARY_KEYS = [
  ['netPnl', 'Net PnL'],
  ['maxDrawdown', 'Max drawdown'],
  ['profitFactor', 'Profit factor'],
  ['expectancy', 'Expectancy'],
  ['trades', 'Trades'],
  ['winRate', 'Win rate %'],
];

const TABS = [
  { id: 'summary', label: 'Resumen' },
  { id: 'trades', label: 'Trades' },
  { id: 'signals', label: 'Senales' },
  { id: 'assumptions', label: 'Supuestos' },
  { id: 'validation', label: 'Validacion' },
];

function normalizeMetricRows(metrics) {
  return SUMMARY_KEYS
    .map(([key, label]) => ({ key, label, value: metrics?.[key] }))
    .filter((row) => row.value != null);
}

function buildSeriesPath(points = [], width = 320, height = 88) {
  if (!points.length) return '';
  const values = points.map((point) => Number(point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - (((Number(point.value) - min) / range) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function MiniSeriesChart({ equitySeries = [], drawdownSeries = [] }) {
  if (!equitySeries.length && !drawdownSeries.length) {
    return (
        <div className={styles.miniChartEmpty}>
        Sin series para graficar todavia.
        </div>
    );
  }

  const equityPath = buildSeriesPath(equitySeries);
  const drawdownPath = buildSeriesPath(drawdownSeries);

  return (
    <div className={styles.miniChartCard}>
      <div className={styles.miniChartHeader}>
        <strong>Equity vs drawdown</strong>
        <span>Vista rapida del draft actual</span>
      </div>
      <svg viewBox="0 0 320 88" className={styles.miniChart} aria-label="Mini chart">
        <path d={equityPath} className={styles.equityPath} />
        <path d={drawdownPath} className={styles.drawdownPath} />
      </svg>
      <div className={styles.miniLegend}>
        <span><i className={styles.legendEquity} /> Equity</span>
        <span><i className={styles.legendDrawdown} /> Drawdown</span>
      </div>
    </div>
  );
}

export function ResultsPanel({
  validationResult,
  backtestResult,
  selectedStrategy,
  draftStatus,
}) {
  const [tab, setTab] = useState('summary');
  const metrics = backtestResult?.metrics || selectedStrategy?.latestBacktest?.summary || null;
  const metricRows = useMemo(() => normalizeMetricRows(metrics), [metrics]);
  const configEntries = useMemo(
    () => Object.entries(backtestResult?.config?.params || {}),
    [backtestResult],
  );

  useEffect(() => {
    if (backtestResult) {
      setTab('summary');
      return;
    }
    if (validationResult) {
      setTab('validation');
    }
  }, [validationResult, backtestResult]);

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'summary' && metrics && (
              <span className={styles.tabBadge}>{metrics.trades ?? 0} trades</span>
            )}
            {item.id === 'validation' && validationResult && (
              <span className={styles.tabBadge}>{validationResult.signal?.type || 'hold'}</span>
            )}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {tab === 'summary' && (
          metrics ? (
            <>
              <div className={styles.infoRow}>
                <span className={styles.infoBadge}>
                  {backtestResult?.config?.strategyMode === 'draft' ? 'Backtest con draft' : 'Ultimo backtest guardado'}
                </span>
                {draftStatus?.lastBacktestAt && (
                  <span className={styles.infoText}>Ultimo backtest: {formatDate(draftStatus.lastBacktestAt)}</span>
                )}
              </div>
              <div className={styles.metricsGrid}>
                {metricRows.map((row) => (
                  <div key={row.key} className={styles.metric}>
                    <span>{row.label}</span>
                    <strong>{typeof row.value === 'number' ? formatNumber(row.value, 2) : String(row.value)}</strong>
                  </div>
                ))}
              </div>
              <MiniSeriesChart
                equitySeries={backtestResult?.equitySeries || []}
                drawdownSeries={backtestResult?.drawdownSeries || []}
              />
              {configEntries.length > 0 && (
                <div className={styles.paramsCard}>
                  <h4 className={styles.sectionTitle}>Parametros efectivos</h4>
                  <div className={styles.paramsGrid}>
                    {configEntries.map(([key, value]) => (
                      <div key={key} className={styles.paramChip}>
                        <span>{key}</span>
                        <strong>{typeof value === 'number' ? formatNumber(value, 4) : String(value)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon="&#128202;" title="Sin backtest" description="Ejecuta un backtest del draft actual para ver metricas, series y parametros." />
          )
        )}

        {tab === 'trades' && (
          backtestResult?.trades?.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Entrada</th>
                    <th>Salida</th>
                    <th>PnL</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {backtestResult.trades.slice().reverse().map((trade, index) => (
                    <tr key={`${trade.entryTime}-${index}`}>
                      <td className={trade.side === 'long' ? styles.long : styles.short}>{trade.side}</td>
                      <td>{formatNumber(trade.entryPrice, 2)}</td>
                      <td>{formatNumber(trade.exitPrice, 2)}</td>
                      <td className={Number(trade.pnl) >= 0 ? styles.long : styles.short}>{formatNumber(trade.pnl, 2)}</td>
                      <td>{trade.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="&#8646;" title="Sin trades detallados" description="Los trades apareceran aqui cuando corras un backtest del draft." />
          )
        )}

        {tab === 'signals' && (
          backtestResult?.signals?.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Signal</th>
                    <th>Action</th>
                    <th>Precio</th>
                  </tr>
                </thead>
                <tbody>
                  {backtestResult.signals.slice(-40).reverse().map((signal, index) => (
                    <tr key={`${signal.closeTime}-${index}`}>
                      <td>{formatDate(signal.closeTime)}</td>
                      <td>{signal.type}</td>
                      <td>{signal.action}</td>
                      <td>{formatNumber(signal.price, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="&#9673;" title="Sin senales" description="Corre una simulacion del draft actual para inspeccionar la secuencia de senales." />
          )
        )}

        {tab === 'assumptions' && (
          backtestResult?.assumptions ? (
            <div className={styles.paramsGrid}>
              {Object.entries(backtestResult.assumptions).map(([key, value]) => (
                <div key={key} className={styles.paramChip}>
                  <span>{key}</span>
                  <strong>{String(value)}</strong>
                </div>
              ))}
              {backtestResult?.config && (
                <>
                  <div className={styles.paramChip}>
                    <span>Rango</span>
                    <strong>{backtestResult.config.limit ? `${backtestResult.config.limit} velas` : 'Custom'}</strong>
                  </div>
                  <div className={styles.paramChip}>
                    <span>Timeframe</span>
                    <strong>{backtestResult.config.timeframe}</strong>
                  </div>
                </>
              )}
            </div>
          ) : (
            <EmptyState icon="&#9881;" title="Sin supuestos" description="Los supuestos de ejecucion apareceran con el proximo backtest del draft." />
          )
        )}

        {tab === 'validation' && (
          validationResult ? (
            <>
              <div className={styles.infoRow}>
                <span className={styles.infoBadge}>Validado con draft</span>
                {draftStatus?.lastValidationAt && (
                  <span className={styles.infoText}>Ultima validacion: {formatDate(draftStatus.lastValidationAt)}</span>
                )}
              </div>
              <div className={styles.metricsGrid}>
                <div className={styles.metric}><span>Asset</span><strong>{validationResult.asset}</strong></div>
                <div className={styles.metric}><span>Timeframe</span><strong>{validationResult.timeframe}</strong></div>
                <div className={styles.metric}><span>Signal</span><strong className={signalClass(validationResult.signal?.type)}>{validationResult.signal?.type || 'hold'}</strong></div>
                <div className={styles.metric}><span>Velas</span><strong>{validationResult.diagnostics?.candles || 0}</strong></div>
              </div>
              <pre className={styles.json}>{JSON.stringify(validationResult.signal, null, 2)}</pre>
            </>
          ) : (
            <EmptyState icon="&#9654;" title="Sin validacion" description="Ejecuta una validacion del draft actual para ver la senal resultante." />
          )
        )}
      </div>
    </div>
  );
}

function signalClass(type) {
  if (type === 'long') return styles.long;
  if (type === 'short') return styles.short;
  return '';
}
