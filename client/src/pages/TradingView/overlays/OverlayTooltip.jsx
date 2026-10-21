import { formatAgo, formatCandleTime, formatOverlayPct, formatOverlayValue, isOptionId } from './overlayFormat';
import styles from './OverlayTooltip.module.css';

function Pct({ value }) {
  const text = formatOverlayPct(value);
  if (!text) return null;
  return <span className={value >= 0 ? styles.up : styles.down}>{text}</span>;
}

// Lectura del puntero: el principal y una fila por superposición dibujada.
// En móvil (`variant="mobile"`) es la barra inferior: admite una acción en la
// cabecera (plegar/desplegar) y, plegada, solo deja la cabecera.
export default function OverlayTooltip({
  variant = 'desktop', time, timeframe, main, rows = [], action = null, collapsed = false, footer = null,
}) {
  const visible = collapsed ? [] : rows.filter((r) => !r.hidden);
  const mobile = variant === 'mobile';
  return (
    <div className={`${styles.tooltip} ${mobile ? styles.mobile : ''}`} aria-label="Valores bajo el puntero">
      <div className={styles.head}>
        <span className={styles.time}>{formatCandleTime(time, timeframe)}</span>
        {action}
      </div>
      {main && !collapsed && (
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
              <div className={styles.note} data-note="">
                {r.lastTradeAgoH != null ? `Última operación hace ${formatAgo(r.lastTradeAgoH)}` : 'Sin operaciones'}
              </div>
            )}
            {/* Móvil: la línea de la nota se reserva en las opciones para que la
                barra no cambie de alto (ni el gráfico salte) al recorrer velas. */}
            {mobile && option && !untraded && <div className={styles.note} data-note="" aria-hidden="true">{'\u00a0'}</div>}
          </div>
        );
      })}
      {!collapsed && footer}
    </div>
  );
}
