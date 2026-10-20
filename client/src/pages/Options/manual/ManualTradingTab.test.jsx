import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ManualTradingTab from './ManualTradingTab';

// jsdom 22 no implementa PointerEvent: sin esto se pierden clientX/clientY.
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? 'touch';
    }
  };
}

const { optionsApi, settingsApi, addNotification } = vi.hoisted(() => ({
  optionsApi: {
    getChain: vi.fn(),
    getAccount: vi.fn(),
    getPositions: vi.fn(),
    getOpenOrders: vi.fn(),
    getTrades: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
  },
  settingsApi: { getOptionsLimits: vi.fn() },
  addNotification: vi.fn(),
}));

vi.mock('../../../services/api', () => ({ optionsApi, settingsApi }));
vi.mock('../../../context/TradingContext', () => ({
  useTradingContext: () => ({ addNotification }),
}));

const leg = (symbol, bid, ask, extra = {}) => ({
  symbol, bid, ask, mark: (bid + ask) / 2, iv: 0.5, delta: 0.5, gamma: 0.0001, theta: -20, vega: 30, openInterest: 40, ...extra,
});

const CHAIN = {
  underlying: 'BTC',
  spot: 68000,
  expiry: '261031',
  expiries: [
    { code: '261017', label: '17 oct', dte: 3 },
    { code: '261031', label: '31 oct', dte: 17 },
  ],
  rows: [
    { strike: 66000, call: leg('BTC-261031-66000-C', 2900, 2950, { delta: 0.7 }), put: leg('BTC-261031-66000-P', 880, 900, { delta: -0.3 }) },
    { strike: 68000, call: leg('BTC-261031-68000-C', 1800, 1840), put: leg('BTC-261031-68000-P', 1750, 1790, { delta: -0.5 }) },
    { strike: 70000, call: leg('BTC-261031-70000-C', 900, 920, { delta: 0.35 }), put: leg('BTC-261031-70000-P', 2800, 2860, { delta: -0.65 }) },
  ],
};

const POSITION = {
  symbol: 'BTC-261031-70000-C', side: 'SHORT', quantity: 0.5, entryPrice: 1180, markPrice: 910,
  unrealizedPnl: 135, delta: -0.17, theta: 10, origin: 'Strangle semanal',
};
const ORDER = { orderId: 77, symbol: 'BTC-261031-66000-P', side: 'BUY', price: 850, quantity: 1, executedQty: 0, createTime: 1760442120000 };

function setMobile(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

function renderTab(props = {}) {
  return render(
    <MemoryRouter>
      <ManualTradingTab underlying="BTC" configured isMobile={false} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setMobile(false);
  optionsApi.getChain.mockResolvedValue(CHAIN);
  optionsApi.getAccount.mockResolvedValue({
    balanceUsdt: 5000, marginUsedUsdt: 1240, unrealizedPnlUsdt: 126.35, greeks: { delta: 0.214, gamma: 0.0031, theta: -18.4, vega: 42.1 },
  });
  optionsApi.getPositions.mockResolvedValue([POSITION]);
  optionsApi.getOpenOrders.mockResolvedValue([ORDER]);
  optionsApi.getTrades.mockResolvedValue([]);
  optionsApi.placeOrder.mockResolvedValue({ orderId: 1 });
  optionsApi.cancelOrder.mockResolvedValue({});
  settingsApi.getOptionsLimits.mockResolvedValue({ maxMarginUsdt: 5000 });
});

describe('ManualTradingTab · escritorio', () => {
  it('agrupa promedio arriba y bid/ask abajo en una sola celda', async () => {
    renderTab();
    const bid = await screen.findByRole('button', { name: 'Vender call 70.000 a 900' });
    const cell = bid.closest('td');
    expect(within(cell).getByRole('button', { name: 'Comprar call 70.000 a 920' })).toBeTruthy();
    expect(within(cell).getByTitle('Promedio entre bid y ask').textContent).toBe('910');
  });
  it('clic en Bid rellena el ticket para vender a ese precio', async () => {
    const user = userEvent.setup();
    renderTab();
    const bid = await screen.findByRole('button', { name: 'Vender call 70.000 a 900' });
    await user.click(bid);

    const ticket = screen.getByRole('complementary', { name: 'Ticket de orden' });
    expect(within(ticket).getByText('BTC-261031-70000-C')).toBeTruthy();
    expect(within(ticket).getByLabelText('Precio límite (USDT)').value).toBe('900');
    expect(within(ticket).getByRole('button', { name: 'Vender', pressed: true })).toBeTruthy();
    expect(within(ticket).getByRole('button', { name: 'Vender call' }).disabled).toBe(false);
    // Venta de 0,1 → prima cobrada +90,00 y break-even 70.900
    expect(within(ticket).getByText('+90,00 USDT')).toBeTruthy();
    expect(within(ticket).getByText('70.900')).toBeTruthy();
  });

  it('cambiar de lado vuelve a poner el precio del ask', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Vender put 66.000 a 880' }));
    const ticket = screen.getByRole('complementary', { name: 'Ticket de orden' });
    await user.click(within(ticket).getByRole('button', { name: 'Comprar' }));
    expect(within(ticket).getByLabelText('Precio límite (USDT)').value).toBe('900');
    expect(within(ticket).getByRole('button', { name: 'Comprar put' })).toBeTruthy();
    // Comprar no requiere margen
    expect(within(ticket).getByText('Margen requerido').nextSibling.textContent).toContain('—');
  });

  it('envía la orden con el payload del contrato tras confirmar', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Comprar call 70.000 a 920' }));
    const ticket = screen.getByRole('complementary', { name: 'Ticket de orden' });
    const qty = within(ticket).getByLabelText('Cantidad (contratos)');
    await user.clear(qty);
    await user.type(qty, '0,5');
    const price = within(ticket).getByLabelText('Precio límite (USDT)');
    await user.clear(price);
    await user.type(price, '915');
    await user.click(within(ticket).getByLabelText('Post-only'));
    await user.click(within(ticket).getByRole('button', { name: 'Comprar call' }));

    // No se envía nada hasta confirmar
    expect(optionsApi.placeOrder).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Comprar BTC-261031-70000-C' });
    await user.click(within(dialog).getByRole('button', { name: 'Enviar orden' }));

    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith({
      symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.5, price: 915, postOnly: true, reduceOnly: false,
    }));
    await waitFor(() => expect(addNotification).toHaveBeenCalledWith('success', 'Orden enviada'));
  });

  it('muestra el error del backend si la orden falla', async () => {
    optionsApi.placeOrder.mockRejectedValueOnce(new Error('Saldo insuficiente'));
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Comprar call 70.000 a 920' }));
    await user.click(screen.getByRole('button', { name: 'Comprar call' }));
    await user.click(await screen.findByRole('button', { name: 'Enviar orden' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Saldo insuficiente');
  });

  it('cerrar una posición corta compra reduce-only al ask tras confirmar', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Cerrar BTC-261031-70000-C' }));
    await user.click(await screen.findByRole('button', { name: 'Cerrar posición' }));
    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith({
      symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.5, price: 920, reduceOnly: true,
    }));
  });

  it('muestra la prima total a mark y el precio de entrada', async () => {
    renderTab();
    expect(await screen.findByText('455,00 USDT')).toBeTruthy(); // 910 × 0,5
    expect(screen.getByText('1.180')).toBeTruthy();
  });

  it('permite programar cierre límite de una posición corta, sin envío previo a confirmar', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Cerrar a precio BTC-261031-70000-C' }));
    const input = screen.getByRole('textbox', { name: 'Precio objetivo para BTC-261031-70000-C' });
    await user.type(input, '850,5');
    expect(screen.getByText('425,25 USDT')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revisar orden de cierre' }));
    expect(optionsApi.placeOrder).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar a precio objetivo' });
    expect(dialog.textContent).toMatch(/no es una orden stop-loss/i);
    await user.click(within(dialog).getByRole('button', { name: 'Enviar cierre límite' }));
    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith({
      symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.5, price: 850.5, reduceOnly: true,
    }));
  });

  it('cancelar una orden abierta pide confirmación', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('tab', { name: /Órdenes abiertas/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancelar orden BTC-261031-66000-P' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar orden' });
    await user.click(within(dialog).getByRole('button', { name: 'Volver' }));
    expect(optionsApi.cancelOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancelar orden BTC-261031-66000-P' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Cancelar orden' })).getByRole('button', { name: 'Cancelar orden' }));
    await waitFor(() => expect(optionsApi.cancelOrder).toHaveBeenCalledWith('BTC-261031-66000-P', 77));
  });

  it('sin credenciales no llama a la cuenta y deshabilita el envío', async () => {
    const user = userEvent.setup();
    renderTab({ configured: false });
    await user.click(await screen.findByRole('button', { name: 'Comprar call 70.000 a 920' }));
    expect(screen.getByRole('button', { name: 'Comprar call' }).disabled).toBe(true);
    expect(optionsApi.getAccount).not.toHaveBeenCalled();
    expect(screen.getAllByRole('link', { name: /Binance Opciones|API key/ }).length).toBeGreaterThan(0);
  });

  it('cambiar de vencimiento vuelve a pedir la cadena', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: /17 oct/ }));
    await waitFor(() => expect(optionsApi.getChain).toHaveBeenLastCalledWith({ underlying: 'BTC', expiry: '261017' }));
  });
});

describe('ManualTradingTab · móvil', () => {
  beforeEach(() => setMobile(true));

  it('tocar un strike abre el ticket en hoja inferior y los steppers cambian la cantidad', async () => {
    const user = userEvent.setup();
    renderTab({ isMobile: true });
    // Cadena de un solo lado: sin tabla de escritorio
    expect(screen.queryByRole('complementary', { name: 'Ticket de orden' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: /^Call 70\.000/ }));

    const sheet = screen.getByRole('dialog', { name: 'Nueva orden' });
    expect(within(sheet).getByText('BTC-261031-70000-C')).toBeTruthy();
    expect(within(sheet).getByLabelText('Precio límite').value).toBe('920');
    await user.click(within(sheet).getByRole('button', { name: 'Más contratos' }));
    expect(within(sheet).getByLabelText('Contratos').value).toBe('0.2');
    await user.click(within(sheet).getByRole('button', { name: 'Subir precio' }));
    // Paso de precio según magnitud: 920 → 1 USDT
    expect(within(sheet).getByLabelText('Precio límite').value).toBe('921');

    await user.click(within(sheet).getByRole('button', { name: /^Comprar call · / }));
    await user.click(await screen.findByRole('button', { name: 'Enviar orden' }));
    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.2, price: 921,
    })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva orden' })).toBeNull());
  });

  it('Calls/Puts cambia el lado de la cadena y marca el spot', async () => {
    const user = userEvent.setup();
    renderTab({ isMobile: true });
    await screen.findByRole('button', { name: /^Call 66\.000/ });
    expect(screen.getByText(/Spot 68\.000/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Puts' }));
    expect(screen.getByRole('button', { name: /^Put 66\.000/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Call 66\.000/ })).toBeNull();
  });

  it('la barra inferior abre la hoja de cartera con posiciones y órdenes', async () => {
    const user = userEvent.setup();
    renderTab({ isMobile: true });
    await user.click(await screen.findByRole('button', { name: /Posiciones · 1/ }));
    const sheet = screen.getByRole('dialog', { name: 'Cartera' });
    expect(within(sheet).getByText('BTC-261031-70000-C')).toBeTruthy();
    expect(within(sheet).getByText(/Strangle semanal/)).toBeTruthy();

    await user.click(within(sheet).getByRole('tab', { name: /Órdenes · 1/ }));
    expect(within(sheet).getByText('BTC-261031-66000-P')).toBeTruthy();

    await user.click(within(sheet).getByRole('tab', { name: /Posiciones/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Cerrar BTC-261031-70000-C' }));
    await user.click(await screen.findByRole('button', { name: 'Cerrar posición' }));
    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: 'BUY', reduceOnly: true,
    })));
  });

  it('muestra entrada y prima total actual en cartera móvil y permite cierre objetivo', async () => {
    const user = userEvent.setup();
    renderTab({ isMobile: true });
    await user.click(await screen.findByRole('button', { name: /Posiciones · 1/ }));
    const sheet = screen.getByRole('dialog', { name: 'Cartera' });
    expect(within(sheet).getByText('Entrada: 1.180 USDT/contrato')).toBeTruthy();
    expect(within(sheet).getByText('Mark: 910 USDT/contrato')).toBeTruthy();
    expect(within(sheet).getByText(/Prima actual:/).textContent).toContain('455,00 USDT');
    await user.click(within(sheet).getByRole('button', { name: 'Cerrar a precio BTC-261031-70000-C' }));
    const input = within(sheet).getByRole('textbox', { name: 'Precio objetivo para BTC-261031-70000-C' });
    await user.type(input, 'abc');
    await user.click(within(sheet).getByRole('button', { name: 'Revisar orden de cierre' }));
    expect(within(sheet).getByRole('alert').textContent).toMatch(/precio objetivo válido/);
    expect(optionsApi.placeOrder).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, '800');
    await user.click(within(sheet).getByRole('button', { name: 'Revisar orden de cierre' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar a precio objetivo' });
    await user.click(within(dialog).getByRole('button', { name: 'Volver' }));
    expect(optionsApi.placeOrder).not.toHaveBeenCalled();
    await user.click(within(sheet).getByRole('button', { name: 'Revisar orden de cierre' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Cerrar a precio objetivo' }))
      .getByRole('button', { name: 'Enviar cierre límite' }));
    await waitFor(() => expect(optionsApi.placeOrder).toHaveBeenCalledWith({
      symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.5, price: 800, reduceOnly: true,
    }));
  });

  it('deslizar una posición revela «Cerrar»', async () => {
    const user = userEvent.setup();
    renderTab({ isMobile: true });
    await user.click(await screen.findByRole('button', { name: /Posiciones · 1/ }));
    const sheet = screen.getByRole('dialog', { name: 'Cartera' });
    const card = within(sheet).getByText('BTC-261031-70000-C').closest('[class*="swipeTrack"]');
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 150, clientY: 10 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 80, clientY: 10 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 80, clientY: 10 });
    const reveal = within(sheet).getByRole('button', { name: 'Cerrar BTC-261031-70000-C (deslizar)' });
    expect(reveal.getAttribute('tabindex')).toBe('0');
  });
});
