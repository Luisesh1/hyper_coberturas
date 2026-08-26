import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, THEME_STORAGE_KEY } from '../../context/ThemeContext';
import { ThemeToggle } from './ThemeToggle';

function renderToggle(props = {}) {
  return render(
    <ThemeProvider>
      <ThemeToggle {...props} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle', () => {
  it('se expone como switch con nombre accesible y estado', () => {
    renderToggle();
    const btn = screen.getByRole('switch', { name: /modo claro/i });
    expect(btn.getAttribute('aria-checked')).toBe('false');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('marca aria-checked cuando el tema claro está activo', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderToggle();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('alterna el tema al hacer clic', async () => {
    renderToggle();
    const btn = screen.getByRole('switch');

    await userEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await userEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('es operable con teclado', async () => {
    renderToggle();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch'));

    await userEvent.keyboard('{Enter}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await userEvent.keyboard(' ');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('el icono es decorativo y el label cambia con el tema', async () => {
    renderToggle({ showLabel: true });
    const btn = screen.getByRole('switch');
    expect(btn.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByText('Modo claro')).toBeTruthy();

    await userEvent.click(btn);
    expect(screen.getByText('Modo oscuro')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /modo oscuro/i })).toBeTruthy();
  });
});
