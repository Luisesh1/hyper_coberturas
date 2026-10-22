import { useLayoutEffect, useRef, useState } from 'react';
import BottomSheet from '../components/BottomSheet';
import { DirectionIcon } from '../../Alerts/components/Direction';
import { baseTfLabel, conditionsLabel, formatDateTime, formatPct } from './alertFormat';
import styles from './AlertMarkerCard.module.css';
import sheetStyles from '../components/MobileChrome.module.css';

const CARD_W = 320;
const GAP = 12;

function EntryBody({ entry, alertsById, colorsById }) {
  const { alertId, event: e } = entry;
  const alert = alertsById?.[alertId];
  return (
    <section className={styles.entry} style={{ '--c': colorsById?.[alertId] ?? '#94a3b8' }}>
      <header className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        {alert && <DirectionIcon direction={alert.direction} size={10} />}
        <span className={styles.name}>{alert?.name ?? 'Alerta eliminada'}</span>
      </header>
      <div className={styles.when}>
        {formatDateTime(e.evalTime)}{alert ? ` · ${baseTfLabel(alert)}` : ''}
      </div>
      <div className={styles.score}>{`Puntuación ${formatPct(e.score)} (umbral ${formatPct(e.threshold)})`}</div>
      {e.suppressed && <span className={styles.badge}>suprimido por cooldown</span>}
      <ul className={styles.rules}>
        {(e.rules || []).map((r, i) => (
          <li key={i} className={styles.rule}>
            <span aria-label={r.matched ? 'cumple' : 'no cumple'}>{r.matched ? '✅' : '❌'}</span>
            <span className={styles.ruleMain}>
              <span className={styles.ruleConds}>{conditionsLabel(r) || `${r.indicatorType} ${r.timeframe}`}</span>
              <span className={styles.ruleMeta}>peso {r.weight}</span>
              {r.reason && <span className={styles.reason}>{r.reason}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Nav({ mobile, index, total, onPrev, onNext }) {
  const cls = `${styles.nav} ${mobile ? styles.navMobile : ''}`;
  return (
    <div className={cls}>
      <button type="button" className={styles.navBtn} onClick={onPrev} disabled={index <= 0}>‹ anterior</button>
      <span className={styles.navPos}>{index + 1} / {total}</span>
      <button type="button" className={styles.navBtn} onClick={onNext} disabled={index >= total - 1}>siguiente ›</button>
    </div>
  );
}

// Tarjeta de detalle de una marca. Móvil: BottomSheet con ‹ anterior / siguiente ›.
// Escritorio: flotante junto a `anchor` ({x, y} en el contenedor), sin salirse de él.
export default function AlertMarkerCard({
  mobile = false, entries = [], alertsById, colorsById, index, onPrev, onNext, onClose, anchor,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (mobile || !anchor) return;
    const parent = ref.current?.offsetParent || ref.current?.parentElement;
    const cw = parent?.clientWidth || 0;
    const ch = parent?.clientHeight || 0;
    const w = ref.current?.offsetWidth || CARD_W;
    const h = ref.current?.offsetHeight || 0;
    let left = anchor.x + GAP;
    if (left + w > cw) left = anchor.x - GAP - w; // no cabe a la derecha: a la izquierda
    left = Math.max(0, Math.min(left, cw - w));
    const top = Math.max(0, Math.min(anchor.y - 16, ch - h));
    setPos({ left, top });
  }, [mobile, anchor, entries, index]);

  if (!entries.length) return null;

  const total = entries.length;
  const single = mobile || Number.isInteger(index);
  const cur = Math.min(Math.max(index ?? 0, 0), total - 1);
  const shown = single ? [entries[cur]] : entries;
  const nav = single && total > 1
    ? <Nav mobile={mobile} index={cur} total={total} onPrev={onPrev} onNext={onNext} />
    : null;
  const bodies = shown.map((en, i) => (
    <EntryBody key={`${en.alertId}:${en.event.evalTime}:${i}`} entry={en} alertsById={alertsById} colorsById={colorsById} />
  ));

  if (mobile) {
    return (
      <BottomSheet open title="Disparo de alerta" onClose={onClose}>
        <div className={sheetStyles.field}>{bodies}</div>
        {nav}
      </BottomSheet>
    );
  }

  return (
    <div
      ref={ref}
      className={styles.card}
      style={{ left: pos.left, top: pos.top, width: CARD_W }}
      role="dialog"
      aria-label="Detalle del disparo"
    >
      <button type="button" className={styles.close} aria-label="Cerrar" onClick={onClose}>✕</button>
      {bodies}
      {nav}
    </div>
  );
}
