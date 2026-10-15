import { ModeBadge } from './ModeSwitch';
import { templateLabel } from './strategyView';
import { formatUsdt, tone } from './common/format';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

function Pnl({ value, className = '' }) {
  return (
    <span className={`${ui.mono} ${ui[`tone_${tone(value) === 'neutral' ? 'muted' : tone(value)}`]} ${className}`}>
      {formatUsdt(value, { sign: true })}
    </span>
  );
}

// P&L de la tarjeta: el real si la estrategia está en real; si no, la sombra.
const cardPnl = (s) => (s.mode === 'live' && Number.isFinite(s.pnlLive) ? s.pnlLive : s.pnlShadow);

export default function StrategyList({ strategies, templates, selectedId, onSelect, mobile = false }) {
  return (
    <ul className={styles.cardList} aria-label="Estrategias">
      {strategies.map((s) => {
        const selected = !mobile && s.id === selectedId;
        return (
          <li key={s.id}>
            <button
              type="button"
              className={`${styles.card} ${mobile ? styles.cardMobile : ''} ${selected ? styles.cardSelected : ''}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(s.id)}
            >
              <span className={styles.cardTop}>
                <span className={styles.cardName}>{s.name}</span>
                <ModeBadge mode={s.mode} />
              </span>
              <span className={styles.cardMeta}>
                {templateLabel(templates, s.template)} · {mobile ? (s.status || s.underlying) : s.underlying}
              </span>
              <span className={styles.cardBottom}>
                <span>P&amp;L 30d {!mobile && <Pnl value={cardPnl(s)} />}</span>
                {mobile ? <Pnl value={cardPnl(s)} className={styles.cardPnlBig} /> : <span>{s.status}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export { Pnl };
