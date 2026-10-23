import { useEffect, useRef } from 'react';
import { MOBILE_QUERY, useMediaQuery } from '../../../TradingView/useMediaQuery';
import { CloseIcon } from './icons';
import styles from './Sheet.module.css';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

// Contenedor de formularios y confirmaciones: hoja inferior en el teléfono
// (zona del pulgar, con el pie fijo) y diálogo centrado en escritorio. Es la
// misma idea que la BottomSheet del gráfico, pero con los tokens del tema
// para que también funcione en modo claro.
export default function Sheet({
  open,
  title,
  description,
  onClose,
  footer,
  children,
  tone = 'default',
  size = 'md',
  closeDisabled = false,
  // false: pulsar fuera no cierra (formularios que se guardan o se cancelan).
  dismissOnScrim = true,
}) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !closeDisabled) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, closeDisabled]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const trigger = document.activeElement;
    document.body.style.overflow = 'hidden';
    const first = panelRef.current?.querySelector(FOCUSABLE);
    (first || panelRef.current)?.focus?.();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  const layerClass = `${styles.layer} ${isMobile ? styles.layerSheet : styles.layerDialog}`;
  const panelClass = [
    styles.panel,
    isMobile ? styles.sheet : styles.dialog,
    !isMobile ? styles[`size_${size}`] : '',
    tone === 'warning' ? styles.warning : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={layerClass}>
      <button
        type="button"
        className={styles.scrim}
        aria-label="Cerrar"
        tabIndex={-1}
        onClick={() => { if (!closeDisabled && dismissOnScrim) onClose?.(); }}
      />
      <section
        ref={panelRef}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {isMobile && <span className={styles.grabber} aria-hidden="true" />}
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title}>{title}</h2>
            {description && <p className={styles.description}>{description}</p>}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Cerrar diálogo"
          >
            <CloseIcon size={20} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>
  );
}
