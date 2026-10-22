import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BotActivity from './BotActivity';

const NOW = Date.now();
const bot = (extra = {}) => ({
  id: 1, mode: 'shadow', underlying: 'ETH',
  params: { takeProfitPct: 80, stopLossPct: 50, maxOpenPositions: 2 },
  limits: {},
  usage: { ordersToday: 1, marginUsedUsdt: 0, dailyLossUsdt: 0 },
  positions: [{ id: 5, mode: 'shadow', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 1, entryPrice: 10, mark: 12, closedAt: null }],
  pendingOrders: [], closedPositions: [], equity: [],
  ...extra,
});
const ATTENTION = { id: 9, purpose: 'standard', action: 'close', symbol: 'ETH-261031-2500-C', side: 'SELL', price: 12, quantity: 1, executedQty: 0, status: 'attention', deadlineAt: NOW + 3600e3 };

describe('BotActivity', () => {
  it('muestra símbolo y P&L de una posición abierta', () => {
    render(<BotActivity bot={bot()} part="top" />);
    expect(screen.getAllByText('ETH-261031-2500-C').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+2,00/).length).toBeGreaterThan(0);
  });

  it('sin posiciones muestra el vacío', () => {
    render(<BotActivity bot={bot({ positions: [] })} part="top" />);
    expect(screen.getByText('Sin posiciones abiertas')).toBeTruthy();
  });

  it('una orden en attention muestra el aviso', () => {
    render(<BotActivity bot={bot({ pendingOrders: [ATTENTION] })} part="top" />);
    expect(screen.getByText('Órdenes pendientes')).toBeTruthy();
    expect(screen.getAllByText('Requiere atención').length).toBeGreaterThan(0);
  });

  it('sin órdenes pendientes no hay sección', () => {
    render(<BotActivity bot={bot()} part="top" />);
    expect(screen.queryByText('Órdenes pendientes')).toBeNull();
  });

  it('en móvil pinta tarjetas y no tablas; en escritorio tabla', () => {
    const { container, rerender } = render(<BotActivity bot={bot({ pendingOrders: [ATTENTION] })} mobile part="top" />);
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getAllByText('ETH-261031-2500-C').length).toBeGreaterThan(0);
    rerender(<BotActivity bot={bot({ pendingOrders: [ATTENTION] })} part="top" />);
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('sin callbacks no hay botones; con ellos se llaman', () => {
    const { rerender } = render(<BotActivity bot={bot({ pendingOrders: [ATTENTION] })} part="top" />);
    expect(screen.queryByRole('button')).toBeNull();
    const onClosePosition = vi.fn();
    const onCancelOrder = vi.fn();
    rerender(<BotActivity bot={bot({ pendingOrders: [ATTENTION] })} part="top" onClosePosition={onClosePosition} onCancelOrder={onCancelOrder} />);
    fireEvent.click(screen.getByRole('button', { name: /Cerrar ETH-261031-2500-C/ }));
    expect(onClosePosition).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: /Cancelar orden 9/ }));
    expect(onCancelOrder).toHaveBeenCalledWith(9);
  });

  it('la parte inferior lista operaciones cerradas con su motivo', () => {
    const closed = [{ id: 3, mode: 'shadow', symbol: 'ETH-261031-2400-C', entryPrice: 10, exitPrice: 15, pnlUsdt: 5, closeReason: 'stop_loss', openedAt: NOW - 1e6, closedAt: NOW }];
    render(<BotActivity bot={bot({ closedPositions: closed })} part="bottom" />);
    expect(screen.getByText('Operaciones cerradas')).toBeTruthy();
    expect(screen.getByText('Stop')).toBeTruthy();
    expect(screen.getByText('Curva de P&L · sombra vs real')).toBeTruthy();
  });

  it('muestra barras de uso de límites', () => {
    render(<BotActivity bot={bot()} part="top" />);
    expect(screen.getByText('Uso de límites')).toBeTruthy();
    expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(0);
  });
});
