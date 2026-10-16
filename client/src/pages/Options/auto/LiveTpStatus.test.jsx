import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import LiveTpStatus from './LiveTpStatus';

const one = {
  id: 1, positionId: 99, symbol: 'BTC-261030-100000-C',
  quantity: 0.2, executedQty: 0, price: 180, status: 'active',
};

describe('indicadores compactos del TP residente', () => {
  it('nunca dice activo si Binance no confirmó la orden', () => {
    render(<LiveTpStatus bot={{ mode: 'live', positions: [{ id: 99, mode: 'live' }],
      takeProfitOrders: [{ ...one, status: 'sending' }] }} />);
    expect(screen.getByText('TP por confirmar')).toBeTruthy();
    expect(screen.queryByText(/TP activo/)).toBeNull();
  });
  it('una orden activa queda visible, sin saturar el detalle inicialmente', () => {
    render(<LiveTpStatus bot={{ mode: 'live', takeProfitOrders: [one] }} />);
    expect(screen.getByText('TP activo · 1')).toBeTruthy();
    const details = screen.getByText('Ver órdenes').closest('details');
    expect(details.open).toBe(false);
  });
  it('una cancelación y un incidente se muestran como advertencias y no como protección', () => {
    const { rerender } = render(<LiveTpStatus bot={{
      mode: 'live', takeProfitOrders: [{ ...one, cancelRequested: true }],
    }} />);
    expect(screen.getByText('Cancelando TP')).toBeTruthy();
    rerender(<LiveTpStatus bot={{ mode: 'live',
      takeProfitOrders: [{ ...one, status: 'attention' }],
    }} />);
    expect(screen.getByText('TP requiere revisión')).toBeTruthy();
  });
  it('sin orden pero con posición informa que no hay TP confirmado', () => {
    render(<LiveTpStatus bot={{ mode: 'live',
      positions: [{ id: 99, mode: 'live', closedAt: null }] }} />);
    expect(screen.getByText('TP sin confirmar')).toBeTruthy();
  });
  it('no muestra estado real en sombra', () => {
    const { container } = render(<LiveTpStatus bot={{ mode: 'shadow', takeProfitOrders: [one] }} />);
    expect(container.textContent).toBe('');
  });
});
