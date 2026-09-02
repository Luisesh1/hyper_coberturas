import styles from './ActionQueue.module.css';

/**
 * Cola de trabajo: lo que pide algo de una persona, arriba de la grilla y
 * antes de cualquier tarjeta.
 *
 * No se renderiza cuando no hay nada que atender. Una franja que aparece
 * siempre —aunque diga "todo bien"— es otra fila de ruido compitiendo por la
 * atención, que es justo lo que este rediseño viene a quitar.
 */
export default function ActionQueue({ items = [], onResolve, onFocus }) {
  if (!items.length) return null;

  const urgentes = items.filter((i) => i.severity === 'urgent').length;
  const tone = urgentes > 0 ? 'urgent' : 'warn';

  return (
    <section className={`${styles.root} ${styles[`root_${tone}`]}`} aria-label="Orquestadores que requieren atención">
      <header className={`${styles.header} ${styles[`header_${tone}`]}`}>
        <span className={styles.headerTitle}>
          <AlertIcon />
          Requiere tu atención
        </span>
        <span className={styles.headerCount}>{items.length}</span>
      </header>

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id} className={styles.item}>
            <span className={`${styles.rail} ${styles[`rail_${item.severity}`]}`} aria-hidden="true" />
            <button
              type="button"
              className={styles.itemBody}
              onClick={() => onFocus?.(item.orchestrator)}
              title="Ir al orquestador"
            >
              <span className={styles.itemTitle}>
                <span className={styles.itemId}>#{item.id}</span>
                {item.pair}
                <span className={styles.itemSep}>—</span>
                {item.issue.title}
              </span>
              <span className={styles.itemSummary}>{item.issue.summary}</span>
            </button>
            <button
              type="button"
              className={`${styles.resolveBtn} ${styles[`resolveBtn_${item.severity}`]}`}
              onClick={() => onResolve?.(item.orchestrator, item.issue)}
            >
              {item.issue.resolveLabel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}
