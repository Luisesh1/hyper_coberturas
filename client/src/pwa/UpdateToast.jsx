import { useEffect, useState } from 'react';
import styles from './UpdateToast.module.css';

export default function UpdateToast() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateSW, setUpdateSW] = useState(null);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;

    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        if (cancelled) return;
        const update = registerSW({
          onNeedRefresh() { setNeedRefresh(true); },
          onRegisterError(err) {
            console.warn('[pwa] SW registration error', err);
          },
        });
        setUpdateSW(() => update);
      })
      .catch((err) => {
        console.warn('[pwa] virtual:pwa-register import failed', err);
      });

    return () => { cancelled = true; };
  }, []);

  if (!needRefresh) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.msg}>Hay una nueva versión disponible.</span>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.reload}
          onClick={() => updateSW && updateSW(true)}
        >
          Recargar
        </button>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setNeedRefresh(false)}
          aria-label="Descartar"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
