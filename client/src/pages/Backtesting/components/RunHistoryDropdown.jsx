import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../../../utils/formatters';
import styles from './RunHistoryDropdown.module.css';

function RunHistoryDropdown({ runs, activeRunId, onSelectRun, onToggleCompare }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((p) => !p)}
      >
        {runs.length} corrida{runs.length !== 1 ? 's' : ''}
      </button>

      {open && (
        <div className={styles.dropdown}>
          {runs.map((run) => {
            const active = run.id === activeRunId;
            const m = run.result?.metrics;
            return (
              <div
                key={run.id}
                className={`${styles.item} ${active ? styles.itemActive : ''}`}
              >
                <button
                  type="button"
                  className={styles.itemMain}
                  onClick={() => { onSelectRun(run.id); setOpen(false); }}
                >
                  <span className={styles.itemLabel}>{run.label}</span>
                  {m && (
                    <span className={styles.itemMeta}>
                      {m.trades}t &middot; {formatNumber(m.netPnl, 1)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className={styles.compareBtn}
                  onClick={() => onToggleCompare(run.id)}
                  title="Comparar"
                >
                  vs
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RunHistoryDropdown;
