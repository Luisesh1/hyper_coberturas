import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AlertChips from './AlertChips';

const alertsById = {
  1: { id: 1, name: 'Cruce RSI', direction: 'bullish', datasource: 'binance' },
  2: { id: 2, name: 'Otra', direction: 'bearish', datasource: 'binance' },
};
const items = [
  { alertId: 1, color: '#facc15', hidden: false },
  { alertId: 2, color: '#fb7185', hidden: true },
];

function setup(props = {}) {
  const h = { onToggleHidden: vi.fn(), onRemove: vi.fn(), onAdd: vi.fn(), onRetry: vi.fn() };
  render(
    <AlertChips
      mobile={false}
      items={items}
      alertsById={alertsById}
      statusByAlert={{ 1: { state: 'ready' }, 2: { state: 'ready' } }}
      countsByAlert={{ 1: 4, 2: 0 }}
      chartDatasource="binance"
      {...h}
      {...props}
    />,
  );
  return h;
}

describe('AlertChips', () => {
  it('muestra nombre y contador de disparos', () => {
    setup();
    expect(screen.getByText('Cruce RSI')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('el ojo llama a onToggleHidden', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: /Ocultar Cruce RSI/ }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: /Mostrar Otra/ }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(2);
  });

  it('la ✕ llama a onRemove y Añadir a onAdd', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: /Quitar Cruce RSI/ }));
    expect(h.onRemove).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: /Añadir/ }));
    expect(h.onAdd).toHaveBeenCalled();
  });

  it('error: Reintentar llama a onRetry', () => {
    const h = setup({ statusByAlert: { 1: { state: 'error', error: 'x' }, 2: { state: 'ready' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.onRetry).toHaveBeenCalledWith(1);
  });

  it('cargando muestra spinner', () => {
    setup({ statusByAlert: { 1: { state: 'loading' }, 2: { state: 'ready' } } });
    expect(screen.getByRole('status', { name: 'Cargando' })).toBeTruthy();
  });

  it('borrada muestra «alerta eliminada»', () => {
    setup({ statusByAlert: { 1: { state: 'deleted' }, 2: { state: 'ready' } } });
    expect(screen.getByText('alerta eliminada')).toBeTruthy();
  });

  it('fuente distinta avisa con ambas fuentes', () => {
    setup({ statusByAlert: { 1: { state: 'ready', sourceMismatch: 'hyperliquid' }, 2: { state: 'ready' } } });
    expect(screen.getByText('evaluada con binance; la alerta usa hyperliquid')).toBeTruthy();
  });

  it('parcial muestra «desde {fecha}»', () => {
    setup({ statusByAlert: { 1: { state: 'ready', partialFromMs: Date.UTC(2026, 9, 1, 12) }, 2: { state: 'ready' } } });
    expect(screen.getByText(/^desde /)).toBeTruthy();
  });

  it('insuficiente solo si > 0', () => {
    const { unmount } = render(
      <AlertChips mobile={false} items={items} alertsById={alertsById} chartDatasource="binance"
        statusByAlert={{ 1: { state: 'ready', insufficient: 0 }, 2: { state: 'ready' } }} countsByAlert={{}} />,
    );
    expect(screen.queryByText(/sin historia suficiente/)).toBeNull();
    unmount();
    setup({ statusByAlert: { 1: { state: 'ready', insufficient: 3 }, 2: { state: 'ready' } } });
    expect(screen.getByText('sin historia suficiente en parte del rango')).toBeTruthy();
  });

  it('approx añade pista de cooldown aproximado', () => {
    setup({ statusByAlert: { 1: { state: 'ready', approx: true }, 2: { state: 'ready' } } });
    expect(screen.getByTitle('cooldown aproximado en el borde')).toBeTruthy();
  });

  it('yahoo avisa de que la evaluación es aproximada (escritorio y hoja móvil)', () => {
    const YAHOO = 'Yahoo: aproximada — se evalúa con la vela final, en vivo se vio a medio formar';
    const { unmount } = render(
      <AlertChips mobile={false} items={items} alertsById={alertsById} chartDatasource="yahoo"
        statusByAlert={{ 1: { state: 'ready' }, 2: { state: 'ready' } }} countsByAlert={{}} />,
    );
    expect(screen.getAllByText(YAHOO)).toHaveLength(2);
    unmount();
    setup({ mobile: true, chartDatasource: 'yahoo' });
    fireEvent.click(screen.getByRole('button', { name: /Cruce RSI/ }));
    expect(screen.getByText(YAHOO)).toBeTruthy();
  });

  it('sin yahoo no hay aviso de aproximada', () => {
    setup();
    expect(screen.queryByText(/^Yahoo: aproximada/)).toBeNull();
  });

  it('móvil: chips como botones y acciones en hoja', () => {
    const h = setup({ mobile: true });
    fireEvent.click(screen.getByRole('button', { name: /Cruce RSI/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar' }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(1);
  });
});
