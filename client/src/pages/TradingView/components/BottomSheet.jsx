import { useEffect } from 'react';
import styles from './MobileChrome.module.css';

// Hoja inferior móvil: un único contenedor para toda la configuración
// (ajustes, temporalidades, etc.). Se cierra con el scrim, Esc o «Listo».
export default function BottomSheet({ open, title, onClose, actionLabel = 'Listo', children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.sheetLayer}>
      <button type="button" className={styles.scrim} onClick={onClose} aria-label="Cerrar" tabIndex={-1} />
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.grabber} aria-hidden="true" />
        <header className={styles.sheetHeader}>
          <h2 className={styles.sheetTitle}>{title}</h2>
          <button type="button" className={styles.sheetAction} onClick={onClose}>{actionLabel}</button>
        </header>
        <div className={styles.sheetBody}>{children}</div>
      </section>
    </div>
  );
}
