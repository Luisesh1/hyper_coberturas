import { orderTip, positionTip } from './chainMarks';
import styles from './ManualTrading.module.css';

const PATHS = {
  star: 'M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z',
  up: 'M8 3l5.5 9h-11z',
  down: 'M8 13L2.5 4h11z',
};

// Icono en SVG: los glifos ★▲▼ dependen de la fuente y salen diminutos.
export function MarkIcon({ kind }) {
  return (
    <svg className={styles.badgeIcon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[kind]} fill="currentColor" />
    </svg>
  );
}

// ★ posición abierta (relleno) y ▲/▼ órdenes pendientes (contorno): se
// distinguen por forma, no solo por color. `reverse` pone la estrella al
// final, para el lado put de la cadena de escritorio.
export default function ChainBadges({ mark, reverse = false }) {
  if (!mark || (!mark.position && !mark.orders.length)) return null;
  const buys = mark.orders.filter((o) => o.buy);
  const sells = mark.orders.filter((o) => !o.buy);
  const items = [];
  if (mark.position) {
    const tip = positionTip(mark.position);
    items.push(<span key="pos" className={`${styles.badge} ${styles.badgePos}`} title={tip} aria-label={tip}><MarkIcon kind="star" /></span>);
  }
  if (buys.length) {
    const tip = buys.map(orderTip).join(' · ');
    items.push(<span key="buy" className={`${styles.badge} ${styles.badgeBuy}`} title={tip} aria-label={tip}><MarkIcon kind="up" /></span>);
  }
  if (sells.length) {
    const tip = sells.map(orderTip).join(' · ');
    items.push(<span key="sell" className={`${styles.badge} ${styles.badgeSell}`} title={tip} aria-label={tip}><MarkIcon kind="down" /></span>);
  }
  if (reverse) items.reverse();
  return <span className={styles.badgeGroup}>{items}</span>;
}

// Contadores de la pastilla de vencimiento.
export function ExpiryBadges({ counts }) {
  if (!counts || (!counts.positions && !counts.orders)) return null;
  return (
    <>
      {counts.positions > 0 && (
        <span className={`${styles.badge} ${styles.badgePos}`} aria-label={`${counts.positions} con posición abierta`}><MarkIcon kind="star" />{counts.positions}</span>
      )}
      {counts.orders > 0 && (
        <span className={`${styles.badge} ${styles.badgeOrd}`} aria-label={`${counts.orders} órdenes pendientes`}><MarkIcon kind="up" /><MarkIcon kind="down" />{counts.orders}</span>
      )}
    </>
  );
}
