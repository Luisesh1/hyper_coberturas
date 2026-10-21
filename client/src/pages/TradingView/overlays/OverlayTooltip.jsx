import { formatAgo, formatCandleTime, formatOverlayPct, formatOverlayValue, isOptionId } from './overlayFormat';
import styles from './OverlayTooltip.module.css';

function Pct({ value }) {
  const text = formatOverlayPct(value);
  if (!text) return null;
  return <span className={value >= 0 ? styles.up : styles.down}>{text}</span>;
}

// Lectura del puntero: el principal y una fila por superposición dibujada.
export default function OverlayTooltip({ variant = 'desktop', time, timeframe, main, rows = [] }) {
  const visible = rows.filter((r) => !r.hidden);
  return (
    <div className={`${styles.tooltip} ${variant === 'mobile' ? styles.mobile : ''}`} aria-label="Valores bajo el puntero">
      <div className={styles.time}>{formatCandleTime(time, timeframe)}</div>
      {main && (
        <div className={styles.row}>
          <span className={styles.name}>
            <span className={styles.mainSwatch} aria-hidden="true" />
            <span>{main.label}</span>
          </span>
          <span className={styles.value}>
            {formatOverlayValue(main.value)} <Pct value={main.changePct} />
          </span>
        </div>
      )}
      {visible.map((r) => {
        const option = isOptionId(r.id);
        const untraded = option && r.traded === false;
        return (
          <div key={r.id} className={styles.block}>
            <div className={styles.row}>
              <span className={styles.name} style={{ '--c': r.color }}>
                <span className={styles.dot} aria-hidden="true" />
                <span>{r.label}</span>
              </span>
              <span className={`${styles.value} ${untraded ? styles.stale : ''}`}>
                {formatOverlayValue(r.value, { usd: option })} <Pct value={r.changePct} />
              </span>
            </div>
            {untraded && (
              <div className={styles.note}>
                {r.lastTradeAgoH != null ? `Última operación hace ${formatAgo(r.lastTradeAgoH)}` : 'Sin operaciones'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
