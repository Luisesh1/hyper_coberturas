import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ExpiryPills from './ExpiryPills';

describe('selector de vencimiento de opciones', () => {
  const expiryMs = Date.UTC(2026, 9, 30, 8, 0, 0);
  const expiries = [
    { code: '261030', label: '30 oct 26', expiryMs, dte: 15 },
    { code: '261106', label: '6 nov 26', expiryMs: Date.UTC(2026, 10, 6, 8), dte: 22 },
  ];
  it('indica hora exacta en UTC únicamente en el contrato seleccionado', () => {
    const onChange = vi.fn();
    render(<ExpiryPills expiries={expiries} value="261030" onChange={onChange} />);
    const selected = screen.getByRole('button', { pressed: true });
    expect(selected.textContent).toContain('08:00 UTC');
    expect(selected.title).toContain('30 oct 26 a las 08:00 UTC');
    expect(screen.getByRole('button', { pressed: false }).textContent).not.toContain('UTC');
    fireEvent.click(screen.getByRole('button', { pressed: false }));
    expect(onChange).toHaveBeenCalledWith('261106');
  });
  it('sin timestamp confirmado no inventa hora de vencimiento', () => {
    render(<ExpiryPills expiries={[{ code: '261030', label: '30 oct 26', dte: 15 }]}
      value="261030" onChange={() => {}} scroller />);
    expect(screen.queryByText(/UTC/)).toBeNull();
  });
});
