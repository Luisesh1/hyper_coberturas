import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from './ThemeContext';

function Probe() {
  const { theme, isLight, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="is-light">{String(isLight)}</span>
      <button onClick={toggleTheme}>toggle</button>
      <button onClick={() => setTheme('light')}>a-claro</button>
      <button onClick={() => setTheme('oscuro-invalido')}>invalido</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '';
});

describe('ThemeContext', () => {
  it('arranca en oscuro cuando no hay nada guardado', () => {
    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('is-light').textContent).toBe('false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignora la preferencia del sistema: oscuro sigue siendo el default', () => {
    window.matchMedia.mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('restaura el tema claro guardado en localStorage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('cae a oscuro si el valor guardado no es válido', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('toggle alterna, persiste y refleja el atributo en <html>', async () => {
    renderProbe();
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));

    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('setTheme acepta valores válidos e ignora los inválidos', async () => {
    renderProbe();
    await userEvent.click(screen.getByRole('button', { name: 'a-claro' }));
    expect(screen.getByTestId('theme').textContent).toBe('light');

    await userEvent.click(screen.getByRole('button', { name: 'invalido' }));
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('sincroniza el meta theme-color con el tema activo', async () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#0f1117');
    document.head.appendChild(meta);

    renderProbe();
    expect(meta.getAttribute('content')).toBe('#0f1117');

    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(meta.getAttribute('content')).toBe('#f6f7fb');
  });

  it('sigue funcionando si localStorage lanza (modo privado / bloqueado)', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });

    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme').textContent).toBe('light');

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('se sincroniza entre pestañas via el evento storage', () => {
    renderProbe();
    expect(screen.getByTestId('theme').textContent).toBe('dark');

    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      window.dispatchEvent(new StorageEvent('storage', {
        key: THEME_STORAGE_KEY,
        newValue: 'light',
      }));
    });

    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('useTheme falla fuera del provider', () => {
    // React re-lanza el error como evento `error` de window y jsdom lo
    // vuelca a stderr; lo silenciamos para no ensuciar la salida del test.
    const swallow = (event) => event.preventDefault();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', swallow);

    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);

    window.removeEventListener('error', swallow);
    spy.mockRestore();
  });
});
