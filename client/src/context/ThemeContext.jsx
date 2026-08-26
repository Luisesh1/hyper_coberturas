/**
 * ThemeContext — apariencia clara/oscura de la UI.
 *
 * El tema vive en un único atributo `data-theme` sobre `<html>`, y
 * `styles/tokens.css` redefine ahí las variables de color. Ningún componente
 * necesita saber qué tema está activo: basta con que use los tokens.
 *
 * Decisiones:
 * - El default es SIEMPRE `dark`. No miramos `prefers-color-scheme` a
 *   propósito: la app nació oscura y un usuario con el SO en claro no debe
 *   ver cambiar su panel al actualizar. El modo claro es opt-in explícito.
 * - La preferencia se guarda en localStorage (no en el backend): es una
 *   opción de dispositivo, y así se aplica antes del login.
 * - Escuchamos `storage` para que dos pestañas abiertas no se contradigan.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';

export const THEME_STORAGE_KEY = 'hlbot_theme';

export const THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';

/** Color de la barra del navegador/PWA por tema (coincide con --bg-primary). */
const THEME_COLOR = {
  dark: '#0f1117',
  light: '#f6f7fb',
};

const isValidTheme = (value) => THEMES.includes(value);

/** Lee la preferencia guardada. localStorage puede lanzar (modo privado). */
export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isValidTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Refleja el tema en el DOM: atributo, color-scheme nativo y meta PWA. */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // `color-scheme` hace que scrollbars, inputs nativos y el fondo del canvas
  // del navegador acompañen al tema sin CSS extra.
  root.style.colorScheme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme);

  // useLayoutEffect: aplicamos el atributo antes del primer pintado para que
  // quien tenga el modo claro guardado no vea un flash oscuro al cargar.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Sin persistencia (modo privado / storage lleno): el tema sigue
      // funcionando en esta pestaña, solo no sobrevive al recargar.
    }
  }, [theme]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      if (isValidTheme(event.newValue)) setThemeState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next) => {
    if (!isValidTheme(next)) return;
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  const value = useMemo(() => ({
    theme,
    isLight: theme === 'light',
    setTheme,
    toggleTheme,
  }), [theme, setTheme, toggleTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme debe usarse dentro de ThemeProvider');
  return ctx;
}
