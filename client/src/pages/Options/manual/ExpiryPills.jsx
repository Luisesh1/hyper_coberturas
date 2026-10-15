import styles from './ManualTrading.module.css';

// Selector de vencimiento: fila que envuelve en escritorio y carrusel
// horizontal en móvil (`scroller`).
export default function ExpiryPills({ expiries = [], value, onChange, scroller = false }) {
  if (!expiries.length) return null;
  return (
    <div role="group" aria-label="Vencimiento" className={scroller ? styles.expiryScroller : styles.pills}>
      {expiries.map((e) => {
        const on = e.code === value;
        return (
          <button
            key={e.code}
            type="button"
            className={`${styles.pill} ${on ? styles.pillOn : ''}`}
            aria-pressed={on}
            onClick={() => onChange(e.code)}
          >
            {e.label}
            {e.dte != null && <span className={styles.pillMeta}>{e.dte}d</span>}
          </button>
        );
      })}
    </div>
  );
}
