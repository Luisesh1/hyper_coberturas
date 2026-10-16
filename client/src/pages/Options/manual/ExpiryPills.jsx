import styles from './ManualTrading.module.css';

// Timestamp exacto publicado por Binance en exchangeInfo; el día visible
// por sí solo no basta para elegir un contrato próximo al vencimiento.
function expiryTime(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// Selector de vencimiento: muestra hora exacta solo del contrato seleccionado,
// manteniendo compactos los demás botones en móvil y escritorio.
export default function ExpiryPills({ expiries = [], value, onChange, scroller = false }) {
  if (!expiries.length) return null;
  return (
    <div role="group" aria-label="Vencimiento" className={scroller ? styles.expiryScroller : styles.pills}>
      {expiries.map((e) => {
        const on = e.code === value;
        const time = expiryTime(e.expiryMs);
        return (
          <button
            key={e.code}
            type="button"
            className={`${styles.pill} ${on ? styles.pillOn : ''}`}
            aria-pressed={on}
            title={time ? `Vence ${e.label} a las ${time}` : `Vence ${e.label}`}
            onClick={() => onChange(e.code)}
          >
            {e.label}
            {e.dte != null && <span className={styles.pillMeta}>{e.dte}d</span>}
            {on && time && <span className={styles.pillMeta}>{time}</span>}
          </button>
        );
      })}
    </div>
  );
}
