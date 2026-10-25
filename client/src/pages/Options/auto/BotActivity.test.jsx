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
const ENTRY = { id: 8, purpose: 'standard', action: 'open', symbol: 'ETH-261031-2600-C', side: 'BUY', price: 5, quantity: 1, executedQty: 0, status: 'active', deadlineAt: NOW + 3600e3 };
const ATTENTION = { id: 9, purpose: 'standard', action: 'close', symbol: 'ETH-261031-2500-C', side: 'SELL', price: 12, quantity: 1, executedQty: 0, status: 'attention', deadlineAt: NOW + 3600e3 };

describe('BotActivity', () => {
  it('muestra símbolo y P&L de una posición abierta', () => {
    render(<BotActivity bot={bot()} part="top" />);
    expect(screen.getAllByText('ETH-261031-2500-C').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+2,00/).length).toBeGreaterThan(0);
  });

  it('atr_band: muestra el desglose con tope y «Calculando objetivo…»', () => {
    const meta = { spot: 3000, bandValue: 3060, distancePct: 2, leverage: 75, appliedGainPct: 200, capped: true };
    const pos = (id, extra) => ({ id, mode: 'shadow', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 1, entryPrice: 10, mark: 12, closedAt: null, ...extra });
    render(<BotActivity bot={bot({ params: { takeProfitMode: 'atr_band', maxOpenPositions: 2 }, positions: [pos(1, { tpTargetPrice: 30, tpTargetMeta: meta }), pos(2, { tpTargetPrice: null, tpTargetMeta: null })] })} part="top" />);
    expect(screen.getAllByText(/\(tope\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Calculando objetivo…').length).toBeGreaterThan(0);
  });

  it('móvil: barra del tiempo consumido entre la ejecución y el vencimiento', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 8), toFake: ['Date'] });
    try {
      // Vence el 31 oct 08:00 UTC: ejecutada 48 h antes de ahora → 50 %.
      const openedAt = Date.UTC(2026, 9, 27, 8);
      render(<BotActivity bot={bot({ positions: [{ ...bot().positions[0], openedAt }] })} mobile part="top" />);
      expect(screen.getByRole('img', { name: 'Transcurrido 50 % de la vida de la opción' })).toBeTruthy();
      expect(screen.getByText('Consumido 50 % del tiempo')).toBeTruthy();
      expect(screen.getByText(/^salida por tiempo en \d+ h$/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('móvil: sin fecha de ejecución no hay barra de tiempo', () => {
    render(<BotActivity bot={bot()} mobile part="top" />);
    expect(screen.queryByText(/^Consumido/)).toBeNull();
  });

  it('posición abierta: prima total y fecha/hora de compra en escritorio y móvil', () => {
    const openedAt = new Date(2026, 9, 22, 14, 5).getTime();
    const withDate = bot({ positions: [{ ...bot().positions[0], openedAt, entryFeeUsdt: 0.5 }] });
    const { rerender } = render(<BotActivity bot={withDate} part="top" />);
    expect(screen.getByText('Prima pagada').nextSibling.textContent).toBe('10,00');
    expect(screen.getByText('Comisiones').nextSibling.textContent).toBe('0,50');
    // P&L neto de comisiones: (12 − 10) × 1 − 0,5.
    expect(screen.getByText('+1,50 USDT neto (+15,0 %)')).toBeTruthy();
    expect(screen.getByText(/Ejecutada 22 oct 14:05/)).toBeTruthy();
    expect(screen.getByText(/^Vencimiento 31 oct 08:00 UTC$/)).toBeTruthy();
    expect(screen.getByText('TP').nextSibling.textContent).toBe('Simulado');
    rerender(<BotActivity bot={withDate} mobile part="top" />);
    expect(screen.getByText(/Prima 10,00 USDT/)).toBeTruthy();
    expect(screen.getByText(/22 oct 14:05/)).toBeTruthy();
  });

  it('escritorio: barra stop–entrada–ahora–TP; móvil: TP con su incremento porcentual', () => {
    const { rerender } = render(<BotActivity bot={bot()} part="top" />);
    expect(screen.getByRole('img', { name: 'Precio actual 12 entre stop 5 y objetivo 18' })).toBeTruthy();
    expect(screen.getByText('TP 18')).toBeTruthy();
    rerender(<BotActivity bot={bot()} mobile part="top" />);
    expect(screen.getByText(/TP 18,00 \(\+80,0 %\)/)).toBeTruthy();
  });

  it('real: estado del TP residente de la posición en Binance', () => {
    const live = bot({
      mode: 'live',
      positions: [{ ...bot().positions[0], mode: 'live' }],
      takeProfitOrders: [{ id: 3, positionId: 5, status: 'active', cancelRequested: false }],
    });
    render(<BotActivity bot={live} part="positions" />);
    expect(screen.getByText('TP en Binance').nextSibling.textContent).toBe('GTC activo');
    expect(screen.queryByText('Uso de límites')).toBeNull();
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
    const { rerender } = render(<BotActivity bot={bot({ pendingOrders: [ENTRY] })} part="top" />);
    expect(screen.queryByRole('button')).toBeNull();
    const onClosePosition = vi.fn();
    const onCancelOrder = vi.fn();
    rerender(<BotActivity bot={bot({ pendingOrders: [ENTRY] })} part="top" onClosePosition={onClosePosition} onCancelOrder={onCancelOrder} />);
    fireEvent.click(screen.getByRole('button', { name: /Cerrar ETH-261031-2500-C/ }));
    expect(onClosePosition).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: /Cancelar orden 8/ }));
    expect(onCancelOrder).toHaveBeenCalledWith(8);
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

  it('«Cerrar todo» en la cabecera; el TP no se cancela y una cancelación pedida no repite botón', () => {
    const onCloseAll = vi.fn();
    const onCancelOrder = vi.fn();
    const tp = { ...ATTENTION, id: 10, purpose: 'take_profit', status: 'active' };
    const asked = { ...ENTRY, id: 11, cancelRequested: true };
    render(<BotActivity bot={bot({ pendingOrders: [ENTRY, ATTENTION, tp, asked] })} part="top" onCloseAll={onCloseAll} onCancelOrder={onCancelOrder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar todo' }));
    expect(onCloseAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Cancelar orden 8/ })).toBeTruthy();
    // Las salidas no se cancelan: se reintentan solas hasta ejecutarse.
    expect(screen.queryByRole('button', { name: /Cancelar orden 9/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar orden 10/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar orden 11/ })).toBeNull();
    expect(screen.getAllByText('Cancelación solicitada').length).toBeGreaterThan(0);
  });

  it('con busy los botones de acción quedan deshabilitados', () => {
    const onClosePosition = vi.fn();
    render(<BotActivity bot={bot({ pendingOrders: [ENTRY] })} part="top" busy onClosePosition={onClosePosition} onCloseAll={vi.fn()} onCancelOrder={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Cerrar ETH-261031-2500-C/ }));
    expect(onClosePosition).not.toHaveBeenCalled();
  });
});
