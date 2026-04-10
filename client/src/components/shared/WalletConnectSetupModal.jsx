import { useEffect, useState } from 'react';
import styles from './WalletConnectSetupModal.module.css';

/**
 * Modal de setup del Project ID de WalletConnect (Reown).
 *
 * WalletConnect/Reown requiere obligatoriamente un Project ID gratuito para
 * conectar al relay. Este modal lo pide una sola vez y lo persiste en
 * localStorage. Una vez guardado, el botón "WalletConnect" abre el QR
 * directamente sin volver a pedirlo.
 */
export default function WalletConnectSetupModal({
  initialValue = '',
  onSave,
  onClose,
  onSavedConnect,
}) {
  const [value, setValue] = useState(initialValue || '');
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(initialValue || '');
  }, [initialValue]);

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Pega tu Project ID antes de continuar.');
      return;
    }
    if (!/^[a-z0-9]{16,}$/i.test(trimmed)) {
      setError('El Project ID debe ser una cadena alfanumérica de al menos 16 caracteres.');
      return;
    }
    setError('');
    onSave?.(trimmed);
    // Si el caller provee onSavedConnect, lo invocamos para encadenar la
    // conexión inmediatamente después de guardar.
    onSavedConnect?.();
    onClose?.();
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>WalletConnect</span>
            <h2 className={styles.title}>🔗 Configurar Project ID</h2>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.intro}>
            WalletConnect (ahora <strong>Reown</strong>) necesita un Project ID gratuito para conectarse a su relay. Es solo un identificador, no requiere KYC ni tarjeta. Este paso es de una sola vez.
          </p>

          <ol className={styles.steps}>
            <li>
              Abre <a
                href="https://cloud.reown.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.link}
              >cloud.reown.com</a> y regístrate (basta con email o GitHub).
            </li>
            <li>Crea un <strong>nuevo proyecto</strong> de tipo <em>AppKit</em> o <em>WalletKit</em>.</li>
            <li>Copia el <strong>Project ID</strong> de la página del proyecto (es una cadena hex de ~32 caracteres).</li>
            <li>Pégalo abajo y guarda. Te quedará persistido para futuras sesiones.</li>
          </ol>

          <div className={styles.field}>
            <label>Project ID</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="ej. a1b2c3d4e5f6..."
              spellCheck={false}
              autoFocus
            />
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <p className={styles.footnote}>
            Se almacena en el navegador (<code>localStorage</code>) y nunca se envía al backend de esta app. Solo lo usa el SDK de WalletConnect para hablar con su relay.
          </p>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={handleSave}>
            Guardar y conectar
          </button>
        </footer>
      </div>
    </div>
  );
}
