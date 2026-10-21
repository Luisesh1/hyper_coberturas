import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ExpiryPills, { formatCountdown } from './ExpiryPills';

describe('selector de vencimiento de opciones', () => {
  const expiryMs = Date.UTC(2026, 9, 30, 8, 0, 0);
  const expiries = [
    { code: '261030', label: '30 oct 26', expiryMs, dte: 15 },
    { code: '261106', label: '6 nov 26', expiryMs: Date.UTC(2026, 10, 6, 8), dte: 22 },
  ];
  const localTime = (ms) => new Date(ms).toLocaleTimeString('es', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  });
  it('indica la hora local únicamente en el contrato seleccionado y la UTC en el título', () => {
    const onChange = vi.fn();
    render(<ExpiryPills expiries={expiries} value="261030" onChange={onChange} />);
    const selected = screen.getByRole('button', { pressed: true });
    expect(selected.textContent).toContain(localTime(expiryMs));
    // En UTC (como el CI) la hora local ya es la UTC: no se repite entre paréntesis.
    const local = localTime(expiryMs);
    expect(selected.title).toContain(local.endsWith('UTC')
      ? `30 oct 26 a las ${local}`
      : `30 oct 26 a las ${local} (08:00 UTC)`);
    if (local.endsWith('UTC')) expect(selected.title).not.toContain('(08:00 UTC)');
    expect(screen.getByRole('button', { pressed: false }).textContent).not.toContain(localTime(expiryMs));
    fireEvent.click(screen.getByRole('button', { pressed: false }));
    expect(onChange).toHaveBeenCalledWith('261106');
  });
  it('sin timestamp confirmado no inventa hora de vencimiento', () => {
    render(<ExpiryPills expiries={[{ code: '261030', label: '30 oct 26', dte: 15 }]}
      value="261030" onChange={() => {}} scroller />);
    expect(screen.queryByText(/UTC/)).toBeNull();
  });
  it('el contrato que vence en menos de 24 h se etiqueta "Hoy"', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 30, 2, 56, 0));
      render(<ExpiryPills expiries={expiries} value="261030" onChange={() => {}} />);
      const today = screen.getByRole('button', { pressed: true });
      expect(today.textContent).toMatch(/^Hoy/);
      expect(today.title).toContain('30 oct 26');
      expect(screen.getByRole('button', { pressed: false }).textContent).toMatch(/^6 nov 26/);
      act(() => { vi.setSystemTime(Date.UTC(2026, 9, 30, 8, 0, 1)); vi.advanceTimersByTime(1000); });
      expect(screen.getByRole('button', { pressed: true }).textContent).toMatch(/^30 oct 26/);
    } finally {
      vi.useRealTimers();
    }
  });
  it('formatea la cuenta regresiva con días y HH:MM:SS', () => {
    const now = Date.UTC(2026, 9, 20, 0, 0, 0);
    expect(formatCountdown(now + ((24 + 8) * 3600 + 5 * 60 + 9) * 1000, now)).toBe('1d 08:05:09');
    expect(formatCountdown(now + 59_000, now)).toBe('00:00:59');
    expect(formatCountdown(now - 1000, now)).toBe('vencido');
    expect(formatCountdown(undefined, now)).toBeNull();
  });
  it('cada vencimiento muestra su cuenta regresiva y avanza cada segundo', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 29, 8, 0, 0));
      render(<ExpiryPills expiries={expiries} value="261030" onChange={() => {}} />);
      expect(screen.getByText('1d 00:00:00')).toBeTruthy();
      expect(screen.getByText('8d 00:00:00')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText('23:59:59')).toBeTruthy();
      expect(screen.getByText('7d 23:59:59')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
