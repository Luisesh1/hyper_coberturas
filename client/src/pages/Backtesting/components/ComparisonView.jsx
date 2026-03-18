import { formatNumber } from '../../../utils/formatters';
import styles from './ComparisonView.module.css';

const METRIC_ROWS = [
  { key: 'trades', label: 'Trades', fmt: (v) => v },
  { key: 'winRate', label: 'Win rate %', fmt: (v) => formatNumber(v, 2) },
  { key: 'netPnl', label: 'Net PnL', fmt: (v) => formatNumber(v, 2) },
  { key: 'maxDrawdown', label: 'Max drawdown', fmt: (v) => formatNumber(v, 2) },
  { key: 'profitFactor', label: 'Profit factor', fmt: (v) => formatNumber(v, 2) },
  { key: 'avgTrade', label: 'Avg trade', fmt: (v) => formatNumber(v, 2) },
  { key: 'bestTrade', label: 'Best trade', fmt: (v) => formatNumber(v, 2) },
  { key: 'worstTrade', label: 'Worst trade', fmt: (v) => formatNumber(v, 2) },
];

function ComparisonView({ runs }) {
  if (runs.length < 2) {
    return (
      <div className={styles.empty}>
        Ejecuta al menos 2 simulaciones para comparar resultados.
      </div>
    );
  }

  const selected = runs.slice(0, 4);

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Metrica</th>
            {selected.map((r) => (
              <th key={r.id}>{r.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => {
            const values = selected.map((r) => r.result?.metrics?.[row.key]);
            const best = Math.max(...values.filter((v) => v != null));
            return (
              <tr key={row.key}>
                <td className={styles.metricLabel}>{row.label}</td>
                {values.map((v, i) => {
                  const isBest = v === best && selected.length > 1;
                  return (
                    <td key={selected[i].id} className={isBest ? styles.best : ''}>
                      {v != null ? row.fmt(v) : '\u2014'}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default ComparisonView;
