import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AlertPicker from './AlertPicker';

const mk = (id, extra = {}) => ({
  id, name: `Alerta ${id}`, direction: 'bullish', datasource: 'binance',
  rules: [{ conditions: [{ indicatorType: 'RSI', timeframe: '15m' }, { indicatorType: 'EMA', timeframe: '4h' }] }, { indicatorType: 'MACD', timeframe: '1h' }],
  ...extra,
});

function setup(props = {}) {
  const h = { onAdd: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() };
  render(
    <MemoryRouter>
      <AlertPicker open mobile={false} alerts={[mk(1), mk(2)]} items={[]} {...h} {...props} />
    </MemoryRouter>,
  );
  return h;
}

describe('AlertPicker', () => {
  it('lista nombre, dirección, temporalidad base y número de reglas', () => {
    setup();
    expect(screen.getByText('Alerta 1')).toBeTruthy();
    expect(screen.getAllByText('Alcista').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15m/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 reglas/).length).toBeGreaterThan(0);
  });

  it('marcar añade y desmarcar quita', () => {
    const h = setup({ items: [{ alertId: 2, color: '#fff', hidden: false }] });
    fireEvent.click(screen.getByRole('checkbox', { name: /Alerta 1/ }));
    expect(h.onAdd).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('checkbox', { name: /Alerta 2/ }));
    expect(h.onRemove).toHaveBeenCalledWith(2);
  });

  it('con 6 seleccionadas deshabilita las demás y avisa del máximo', () => {
    const alerts = [1, 2, 3, 4, 5, 6, 7].map((i) => mk(i));
    const items = [1, 2, 3, 4, 5, 6].map((i) => ({ alertId: i, color: '#fff', hidden: false }));
    const h = setup({ alerts, items });
    const seventh = screen.getByRole('checkbox', { name: /Alerta 7/ });
    expect(seventh.disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: /Alerta 1/ }).disabled).toBe(false);
    expect(screen.getAllByText(/máximo 6/i).length).toBeGreaterThan(0);
    fireEvent.click(seventh);
    expect(h.onAdd).not.toHaveBeenCalled();
  });

  it('sin alertas muestra el estado vacío con enlace a /alerts', () => {
    setup({ alerts: [] });
    expect(screen.getByText(/No tienes alertas/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Alertas/ }).getAttribute('href')).toBe('/alerts');
  });

  it('en móvil usa una hoja inferior', () => {
    setup({ mobile: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Alerta 1')).toBeTruthy();
  });
});
