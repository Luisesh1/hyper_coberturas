import { useCallback, useEffect, useState } from 'react';

// Pantalla completa: intenta la Fullscreen API nativa (desktop/Android) y
// cae a "pseudo-fullscreen" vía CSS (iOS Safari, que no soporta la API en
// divs). El componente aplica su clase fixed cuando `fullscreen` es true.
export function useFullscreen(ref) {
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreen;
    setFullscreen(next);
    try {
      if (next) {
        const el = ref.current;
        if (el?.requestFullscreen) el.requestFullscreen().catch(() => { /* noop */ });
      } else if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => { /* noop */ });
      }
    } catch { /* noop */ }
  }, [fullscreen, ref]);

  // Sincroniza cuando el usuario sale de fullscreen con Esc o con el botón del navegador.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // En iOS (o cuando la API nativa no disparó), Esc también debe cerrar el pseudo-fullscreen.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Marca <body> con una clase mientras estamos en fullscreen para que el
  // header global (App) pueda ocultarse en mobile y aprovechar todo el alto.
  useEffect(() => {
    if (!fullscreen) return undefined;
    document.body.classList.add('tv-fullscreen-active');
    return () => document.body.classList.remove('tv-fullscreen-active');
  }, [fullscreen]);

  // Al desmontar (p. ej. navegar a otra ruta) no dejar la página en fullscreen nativo.
  useEffect(() => () => {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => { /* noop */ });
      }
    } catch { /* noop */ }
  }, []);

  return { fullscreen, toggleFullscreen };
}
