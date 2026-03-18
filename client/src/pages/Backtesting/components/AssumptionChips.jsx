import { toDatetimeLocal } from '../../../components/Backtesting/backtesting-utils';
import styles from './BottomPanel.module.css';

function AssumptionChips({ result, selectedStrategy }) {
  const entries = Object.entries(result.assumptions || {});
  const extra = [
    ['Rango', result.config?.from
      ? `${toDatetimeLocal(result.config.from)} \u2192 ${toDatetimeLocal(result.config.to)}`
      : `${result.config?.limit || '\u2014'} velas`],
    ['Estrategia', selectedStrategy?.name || `#${result.config?.strategyId}`],
  ];

  return (
    <div className={styles.tabContent}>
      <div className={styles.chipGrid}>
        {[...entries, ...extra].map(([key, value]) => (
          <div key={key} className={styles.assumptionChip}>
            <span className={styles.assumptionKey}>{key}</span>
            <span className={styles.assumptionVal}>{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AssumptionChips;
