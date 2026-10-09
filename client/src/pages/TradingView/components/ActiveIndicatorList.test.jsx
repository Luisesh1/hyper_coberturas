import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ActiveIndicatorList from './ActiveIndicatorList';

// jsdom 22 no implementa PointerEvent: sin esto fireEvent.pointer* crea un
// Event genérico y se pierden clientX/clientY.
beforeAll(() => {
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? 'touch';
      }
    };
  }
});

const originalMatchMedia = window.matchMedia;

function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderList(overrides = {}) {
  const props = {
    indicators: [
      { uid: 'u1', type: 'bollinger', params: { length: 20, stdDev: 2 }, visible: true },
      { uid: 'u2', type: 'vwap', params: {}, visible: false },
    ],
    selectedUid: null,
    onSelect: vi.fn(),
    onToggleVisible: vi.fn(),
    onRemove: vi.fn(),
    onAddNew: vi.fn(),
    ...overrides,
  };
  render(<ActiveIndicatorList {...props} />);
  return props;
}

afterEach(() => { window.matchMedia = originalMatchMedia; });

describe('ActiveIndicatorList', () => {
  it('muestra los parámetros con las etiquetas del catálogo', () => {
    mockViewport(false);
    renderList();
    expect(screen.getByText('Periodo 20 · Desv. estándar 2')).toBeTruthy();
    expect(screen.getByText('Volume Weighted Average Price')).toBeTruthy();
  });

  it('en escritorio mantiene la papelera y no ofrece «Quitar»', () => {
    mockViewport(false);
    const props = renderList();
    expect(screen.queryByRole('button', { name: 'Quitar Bollinger Bands', hidden: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Bollinger Bands' }));
    expect(props.onRemove).toHaveBeenCalledWith('u1');
  });

  it('en móvil, deslizar a la izquierda revela «Quitar» y al tocarlo elimina', () => {
    mockViewport(true);
    const props = renderList();
    const row = screen.getByText('Bollinger Bands').closest('[data-swipe-row]');
    // Cerrado: el botón no es alcanzable (está debajo del contenido).
    expect(screen.queryByRole('button', { name: 'Quitar Bollinger Bands' })).toBeNull();

    fireEvent.pointerDown(row, { clientX: 300, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 250, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 180, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 180, clientY: 10, pointerId: 1 });
    // El click que sigue al arrastre no selecciona la fila.
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Quitar Bollinger Bands' }));
    expect(props.onRemove).toHaveBeenCalledWith('u1');
  });

  it('en móvil, tocar una fila abierta la cierra en vez de seleccionarla', () => {
    mockViewport(true);
    const props = renderList();
    const row = screen.getByText('Bollinger Bands').closest('[data-swipe-row]');
    fireEvent.pointerDown(row, { clientX: 300, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 150, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 150, clientY: 10, pointerId: 1 });
    fireEvent.click(row);

    fireEvent.pointerDown(row, { clientX: 100, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 100, clientY: 10, pointerId: 1 });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Quitar Bollinger Bands' })).toBeNull();

    fireEvent.click(row);
    expect(props.onSelect).toHaveBeenCalledWith('u1');
  });

  it('en móvil la papelera sigue accesible sin gesto (teclado / lector de pantalla)', () => {
    mockViewport(true);
    const props = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar Bollinger Bands' }));
    expect(props.onRemove).toHaveBeenCalledWith('u1');
  });
});
