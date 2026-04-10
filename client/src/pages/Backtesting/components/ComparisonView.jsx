import { formatNumber } from '../../../utils/formatters';
import styles from './ComparisonView.module.css';

const METRIC_ROWS = [
  { key: 'netPnl', label: 'Net PnL', fmt: (v) => formatNumber(v, 2) },
  { key: 'maxDrawdown', label: 'Max drawdown', fmt: (v) => formatNumber(v, 2) },
  { key: 'profitFactor', label: 'Profit factor', fmt: (v) => formatNumber(v, 2) },
  { key: 'expectancy', label: 'Expectancy', fmt: (v) => formatNumber(v, 2) },
  { key: 'trades', label: 'Trades', fmt: (v) => formatNumber(v, 0) },
  { key: 'winRate', label: 'Win rate %', fmt: (v) => formatNumber(v, 2) },
  { key: 'feePaid', label: 'Fees', fmt: (v) => formatNumber(v, 2) },
  { key: 'slippagePaid', label: 'Slippage', fmt: (v) => formatNumber(v, 2) },
];

function ComparisonView({
  runs,
  activeRunId,
  activeResult,
  compareTarget,
  onToggleCompare,
  onSelectBenchmark,
}) {
  const benchmarkEntries = Object.values(activeResult?.benchmarks || {});
  const activeRun = runs.find((run) => run.id === activeRunId) || null;
  const selectedRunIds = runs.filter((run) => run.id !== activeRunId).slice(0, 4);
  const selectedBenchmarkKey = compareTarget?.type === 'benchmark' ? compareTarget.key : null;
  const compareColumn = compareTarget?.type === 'run'
    ? runs.find((run) => run.id === compareTarget.id)?.result
    : selectedBenchmarkKey
      ? activeResult?.benchmarks?.[selectedBenchmarkKey]
      : null;

  if (!activeResult) {
    return (
      <div className={styles.empty}>
        Ejecuta una simulacion para habilitar la comparacion.
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.selectorGroup}>
          <span className={styles.selectorTitle}>Comparar contra corridas</span>
          <div className={styles.selectorRow}>
            {selectedRunIds.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`${styles.selectorBtn} ${compareTarget?.type === 'run' && compareTarget.id === run.id ? styles.selectorBtnActive : ''}`}
                onClick={() => onToggleCompare(run.id)}
              >
                {run.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.selectorGroup}>
          <span className={styles.selectorTitle}>Benchmarks</span>
          <div className={styles.selectorRow}>
            {benchmarkEntries.map((benchmark) => (
              <button
                key={benchmark.key}
                type="button"
                className={`${styles.selectorBtn} ${selectedBenchmarkKey === benchmark.key ? styles.selectorBtnActive : ''}`}
                onClick={() => onSelectBenchmark(benchmark.key)}
              >
                {benchmark.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {compareColumn ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Metrica</th>
              <th>{activeRun?.label || 'Activo'}</th>
              <th>{compareTarget?.type === 'run'
                ? runs.find((run) => run.id === compareTarget.id)?.label
                : activeResult?.benchmarks?.[selectedBenchmarkKey]?.label}</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ROWS.map((row) => {
              const activeValue = activeResult?.metrics?.[row.key];
              const compareValue = compareColumn?.metrics?.[row.key];
              return (
                <tr key={row.key}>
                  <td className={styles.metricLabel}>{row.label}</td>
                  <td>{activeValue != null ? row.fmt(activeValue) : '\u2014'}</td>
                  <td>{compareValue != null ? row.fmt(compareValue) : '\u2014'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className={styles.empty}>
          Elige una corrida previa o un benchmark para comparar la simulacion activa.
        </div>
      )}
    </div>
  );
}

export default ComparisonView;
