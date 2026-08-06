import { useCallback, useEffect, useRef } from 'react';
import styles from './ModalShell.module.css';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Cáscara compartida de todos los diálogos del orquestador.
 *
 * Resuelve una sola vez lo que antes estaba copiado en cada modal: Escape,
 * click fuera, role/aria, focus trap, bloqueo del scroll del body y
 * devolución del foco al disparador.
 *
 * El lenguaje visual es el de UnifiedLpWizard; ver
 * docs/superpowers/specs/2026-08-05-modales-orquestador-design.md
 */
export default function ModalShell({
  eyebrow,
  title,
  desc,
  headerActions,
  footer,
  children,
  size = 'md',
  variant = 'center',
  stacked = false,
  onClose,
  closeDisabled = false,
  ariaLabel,
  className = '',
  bodyClassName = '',
}) {
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);

  const requestClose = useCallback(() => {
    if (closeDisabled) return;
    onClose?.();
  }, [closeDisabled, onClose]);

  // Escape cierra, salvo mientras una acción en curso lo bloquee.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  // Bloqueo del scroll del body. Guardamos el valor previo en vez de asumir
  // '' porque puede haber otro modal apilado que ya lo había fijado.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  // Foco inicial dentro del diálogo y devolución al disparador al cerrar.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const first = dialogRef.current?.querySelector(FOCUSABLE);
    (first || dialogRef.current)?.focus();

    return () => {
      const trigger = triggerRef.current;
      if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
        trigger.focus();
      }
    };
  }, []);

  // Focus trap: Tab cicla dentro del diálogo en ambos sentidos.
  function handleDialogKeyDown(event) {
    if (event.key !== 'Tab') return;

    // Sin filtro de visibilidad a propósito: el selector ya descarta disabled y
    // type="hidden", y offsetParent es siempre null bajo jsdom, lo que dejaría
    // la lista en un único elemento y el trap girando sobre sí mismo.
    const focusables = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || []);
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const isDrawer = variant === 'drawer';
  const overlayClass = [
    styles.overlay,
    isDrawer ? styles.overlayDrawer : '',
    stacked ? styles.overlayStacked : '',
  ].filter(Boolean).join(' ');
  const surfaceClass = [
    isDrawer ? styles.drawer : styles.modal,
    isDrawer ? '' : styles[`size_${size}`],
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={overlayClass}
      onClick={requestClose}
      data-testid="modal-overlay"
    >
      <div
        ref={dialogRef}
        className={surfaceClass}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || (typeof title === 'string' ? title : undefined)}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
            {title && <h2 className={styles.title}>{title}</h2>}
            {desc && <p className={styles.desc}>{desc}</p>}
          </div>
          <div className={styles.headerActions}>
            {headerActions}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={requestClose}
              disabled={closeDisabled}
              // "Cerrar diálogo" y no "Cerrar": varios modales tienen además un
              // botón "Cerrar" en el pie, y dos controles con el mismo nombre
              // accesible dentro del mismo diálogo son indistinguibles con
              // lector de pantalla.
              aria-label="Cerrar diálogo"
            >
              ✕
            </button>
          </div>
        </header>

        <div className={`${styles.body} ${bodyClassName}`.trim()}>{children}</div>

        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  );
}
