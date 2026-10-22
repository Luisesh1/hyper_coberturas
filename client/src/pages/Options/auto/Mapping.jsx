import DirectionChip from './DirectionChip';
import { buildMapping } from './botView';
import styles from './AutoTradingTab.module.css';

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

// Vista previa «qué abre cada dirección» con la estructura elegida.
export default function Mapping({ structure, targetDelta, expiryDays, alerts, compact = false }) {
  const rows = buildMapping(structure, { targetDelta, expiryDays, alerts });
  return (
    <ul className={`${styles.mapping} ${compact ? styles.mappingCompact : ''}`} aria-label="Qué abre cada dirección" aria-live="polite">
      {rows.map((r) => (
        <li key={r.direction} className={styles.mapRow}>
          <DirectionChip direction={r.direction} />
          {!compact && <span className={styles.mapArrow}><ArrowIcon /></span>}
          <span className={styles.mapAction}>
            <strong className={r.side === 'buy' ? styles.actBuy : styles.actSell}>{r.action}</strong>
            {' '}
            <span className={styles.mapDetail}>{r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
