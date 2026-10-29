import { PERIOD_OPTIONS, toDateInput } from './botPeriod';
import styles from './AutoTradingTab.module.css';

// Selector «Periodo» de las estadísticas: Todo, 7 d, 3 d o desde una fecha.
// `onPick(kind)` cambia de opción; `onDate(YYYY-MM-DD)` fija la fecha.
export default function PeriodSelect({ period, onPick, onDate }) {
  return (
    <div className={styles.periodBar}>
      <div role="group" aria-label="Periodo" className={styles.filters}>
        <span className={styles.periodLabel}>Periodo</span>
        {PERIOD_OPTIONS.map((o) => (
          <button
            key={o.kind}
            type="button"
            className={`${styles.filterBtn} ${styles.periodBtn} ${period.kind === o.kind ? styles.filterBtnOn : ''}`}
            aria-pressed={period.kind === o.kind}
            onClick={() => onPick(o.kind)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {period.kind === 'since' && (
        <label className={styles.periodDate}>
          <span>Fecha de inicio</span>
          <input
            type="date"
            value={Number.isFinite(period.since) ? toDateInput(period.since) : ''}
            max={toDateInput(Date.now())}
            onChange={(e) => onDate(e.target.value)}
          />
        </label>
      )}
    </div>
  );
}
