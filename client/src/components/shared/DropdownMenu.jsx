import { useEffect, useRef, useState } from 'react';
import styles from './DropdownMenu.module.css';

export function DropdownMenu({ trigger, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className={styles.wrapper} ref={ref}>
      <button className={styles.trigger} onClick={() => setOpen(!open)} type="button">
        {trigger || '...'}
      </button>
      {open && (
        <div className={styles.menu}>
          {items.map((item, i) => (
            <button
              key={i}
              className={`${styles.item} ${item.danger ? styles.danger : ''}`}
              onClick={() => { setOpen(false); item.onClick(); }}
              disabled={item.disabled}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
