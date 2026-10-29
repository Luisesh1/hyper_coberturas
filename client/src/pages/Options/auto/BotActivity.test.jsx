import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BotActivity from './BotActivity';
import { formatDateTime } from '../strategies/common/format';

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

  it('móvil: con tiempo máximo la salida se cuenta desde la ejecución', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 8), toFake: ['Date'] });
    try {
      const openedAt = Date.UTC(2026, 9, 29, 7);
      render(<BotActivity bot={bot({ params: { takeProfitMode: 'atr_band', maxHoldMinutes: 240 }, positions: [{ ...bot().positions[0], openedAt }] })} mobile part="top" />);
      expect(screen.getByText('cierre por tiempo máx. en 3 h')).toBeTruthy();
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

  it('operaciones cerradas: el desplegable muestra máximo y mínimo de la prima y cuándo se alcanzaron', () => {
    const OPEN = NOW - 5 * 3600e3;
    const closed = [
      { id: 3, mode: 'shadow', symbol: 'BTC-261030-81500-P', side: 'BUY', entryPrice: 765, exitPrice: 1025, pnlUsdt: 27.46,
        closeReason: 'take_profit_atr_band', openedAt: OPEN, closedAt: OPEN + 71 * 60e3,
        premiumRange: { high: { price: 1025, at: OPEN + 71 * 60e3 }, low: { price: 612, at: OPEN + 12 * 60e3 }, partial: false } },
      { id: 4, mode: 'shadow', symbol: 'ETH-261027-2300-P', side: 'BUY', entryPrice: 15.4, exitPrice: 0, pnlUsdt: -104.46,
        closeReason: 'expiry', openedAt: OPEN, closedAt: NOW, premiumRange: null },
    ];
    render(<BotActivity bot={bot({ closedPositions: closed })} part="bottom" />);
    const toggle = screen.getByRole('button', { name: 'Ver máximo y mínimo de la prima de BTC-261030-81500-P' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Prima máxima (bid)')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls'))).not.toBeNull();
    expect(screen.getByText('Prima máxima (bid)')).toBeTruthy();
    expect(screen.getByText('a 1 h 11 min de la compra')).toBeTruthy();
    expect(screen.getByText('a 12 min de la compra')).toBeTruthy();
    // La fecha exacta de cada extremo se ve (no solo en el title, que el móvil no muestra).
    const highTime = screen.getByText(formatDateTime(OPEN + 71 * 60e3), { selector: 'time' });
    expect(highTime.getAttribute('datetime')).toBe(new Date(OPEN + 71 * 60e3).toISOString());
    expect(screen.getByText(formatDateTime(OPEN + 12 * 60e3), { selector: 'time' })).toBeTruthy();
    expect(screen.getByText('+34,0 %')).toBeTruthy();
    expect(screen.getByText('−20,0 %')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /prima de ETH-261027-2300-P/ }));
    expect(screen.getByText(/Sin registro de la prima/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ocultar máximo y mínimo de la prima de BTC/ }));
    expect(screen.queryByText('Prima máxima (bid)')).toBeNull();
  });

  it('operaciones cerradas en móvil: la tarjeta entera despliega el rango (aproximado si es parcial)', () => {
    const OPEN = NOW - 3 * 86400e3;
    const closed = [{ id: 3, mode: 'shadow', symbol: 'BTC-261026-81000-C', side: 'BUY', entryPrice: 315, exitPrice: 0, pnlUsdt: -105.11,
      closeReason: 'expiry', openedAt: OPEN, closedAt: NOW,
      premiumRange: { high: { price: 480, at: OPEN + 28 * 3600e3 }, low: { price: 0, at: NOW }, partial: true } }];
    const { container } = render(<BotActivity bot={bot({ closedPositions: closed })} mobile part="bottom" />);
    expect(container.querySelector('table')).toBeNull();
    const toggle = screen.getByRole('button', { name: /BTC-261026-81000-C/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('a 1 día 4 h de la compra')).toBeTruthy();
    expect(screen.getByText(/Aproximado: la operación se abrió antes del muestreo/)).toBeTruthy();
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
