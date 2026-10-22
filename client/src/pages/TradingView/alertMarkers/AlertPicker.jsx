import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import BottomSheet from '../components/BottomSheet';
import { DirectionChip } from '../../Alerts/components/Direction';
import { MAX_ALERT_MARKERS } from './markerModel';
import { baseTfLabel, ruleCountLabel } from './alertFormat';
import styles from './AlertPicker.module.css';

function Body({ mobile, alerts, items, onAdd, onRemove }) {
  const selected = new Set(items.map((i) => i.alertId));
  const full = items.length >= MAX_ALERT_MARKERS;

  if (!alerts.length) {
    return (
      <p className={styles.empty}>
        No tienes alertas. <Link to="/alerts" className={styles.link}>Créalas en Alertas</Link>
      </p>
    );
  }

  return (
    <ul className={styles.list}>
      {alerts.map((a) => {
        const on = selected.has(a.id);
        const blocked = full && !on;
        return (
          <li key={a.id}>
            <label className={`${styles.row} ${mobile ? styles.rowMobile : ''} ${blocked ? styles.rowBlocked : ''}`}>
              <input
                type="checkbox"
                className={styles.check}
                checked={on}
                disabled={blocked}
                aria-label={a.name}
                onChange={() => { if (blocked) return; if (on) onRemove?.(a.id); else onAdd?.(a.id); }}
              />
              <span className={styles.main}>
                <span className={styles.name}>{a.name}</span>
                <span className={styles.meta}>
                  <DirectionChip direction={a.direction} />
                  <span>{baseTfLabel(a)}</span>
                  <span>{ruleCountLabel(a)}</span>
                  {blocked && <span className={styles.max}>máximo {MAX_ALERT_MARKERS}</span>}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

// Selector de alertas a marcar en el gráfico. Escritorio: modal; móvil: BottomSheet.
export default function AlertPicker({ open, mobile = false, alerts = [], items = [], onAdd, onRemove, onClose }) {
  useEffect(() => {
    if (!open || mobile) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, mobile, onClose]);

  if (!open) return null;
  const counter = `${items.length} de ${MAX_ALERT_MARKERS}`;
  const body = <Body mobile={mobile} alerts={alerts} items={items} onAdd={onAdd} onRemove={onRemove} />;

  if (mobile) {
    return (
      <BottomSheet open title="Alertas en el gráfico" onClose={onClose}>
        <span className={styles.counter}>{counter}</span>
        {body}
      </BottomSheet>
    );
  }
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Alertas en el gráfico" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.title}>Alertas en el gráfico</h2>
          <span className={styles.counter}>{counter}</span>
          <span className={styles.grow} />
          <button type="button" className={styles.closeBtn} aria-label="Cerrar" onClick={onClose}>✕</button>
        </header>
        <div className={styles.scroll}>{body}</div>
      </div>
    </div>
  );
}
