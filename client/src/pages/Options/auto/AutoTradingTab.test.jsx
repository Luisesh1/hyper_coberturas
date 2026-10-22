import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutoTradingTab, { SIGNALS_POLL_MS } from './AutoTradingTab';
import { optionsStrategiesApi } from '../optionsAutomationApi';
import { autoBotsApi } from '../autoTradingApi';

vi.mock('../optionsAutomationApi', () => ({
  optionsStrategiesApi: {
    listTemplates: vi.fn(), list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), setMode: vi.fn(), remove: vi.fn(),
  },
  optionsBacktestsApi: { create: vi.fn(), list: vi.fn(), get: vi.fn() },
}));
vi.mock('../autoTradingApi', () => ({
  SIGNAL_FILTERS: ['all', 'traded', 'ignored'],
  autoBotsApi: { list: vi.fn(), eligibleAlerts: vi.fn(), create: vi.fn(), update: vi.fn(), signals: vi.fn(), close: vi.fn(), cancelOrder: vi.fn() },
}));

const ALERT_UP = { id: 11, name: 'BTC · MACD cruce alcista 15m', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 };
const ALERT_DOWN = { id: 12, name: 'BTC · MACD cruce bajista 15m', direction: 'bearish', assetList: ['BTCUSDT'], thresholdPercent: 70 };
const NOW = Date.now();

const LIST = [
  {
    id: 1, name: 'Momentum BTC', template: 'alert_signal', underlying: 'BTC', mode: 'shadow', status: 'Call abierta',
    params: { alertIds: [11, 12], structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, quantity: 0.05 },
    alerts: [ALERT_UP, ALERT_DOWN], pnl30d: { shadow: 214.6, live: null },
    lastSignal: { alertName: ALERT_UP.name, direction: 'bullish', asset: 'BTCUSDT', decision: 'opened', detail: 'Compra BTC-261024-70000-C a 905', createdAt: NOW - 60000 },
  },
  {
    id: 2, name: 'Breakout SOL', template: 'alert_signal', underlying: 'SOL', mode: 'paused', status: 'Pausado',
    params: { alertIds: [21], structure: 'sell_against', targetDelta: 0.25 },
    alerts: [{ id: 21, name: 'SOL breakout', direction: 'bullish', assetList: ['SOLUSDT'] }], pnl30d: { shadow: -22.4, live: null },
    lastSignal: null,
  },
];

const SIGNALS = [
  { id: 101, alertId: 11, alertName: ALERT_UP.name, direction: 'bullish', asset: 'BTCUSDT', score: 85, decision: 'opened', detail: 'Compra BTC-261024-70000-C a 905 · 0,05', createdAt: NOW - 60000 },
  { id: 102, alertId: 12, alertName: ALERT_DOWN.name, direction: 'bearish', asset: 'BTCUSDT', score: 72, decision: 'ignored', detail: 'Ya hay una posición abierta (máx. 1)', createdAt: NOW - 120000 },
];

// Servidor de mentira: modo y alertas vinculadas se reflejan en list/get.
let serverModes;
let serverAlertIds;
const withServerState = (b) => ({
  ...b,
  mode: serverModes[b.id],
  params: { ...b.params, alertIds: serverAlertIds[b.id] },
  alerts: b.alerts.filter((a) => serverAlertIds[b.id].includes(a.id)),
});
const originalMatchMedia = window.matchMedia;
function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

function renderTab(props = {}) {
  return render(<MemoryRouter><AutoTradingTab {...props} /></MemoryRouter>);
}

beforeEach(() => {
  // Aquí y no sólo en afterEach: el desmontaje del test anterior puede
  // resolver promesas pendientes después de limpiar.
  vi.clearAllMocks();
  mockViewport(false);
  serverModes = { 1: 'shadow', 2: 'paused' };
  serverAlertIds = { 1: [11, 12], 2: [21] };
  autoBotsApi.list.mockImplementation(async () => LIST.map(withServerState));
  autoBotsApi.eligibleAlerts.mockImplementation(async (u) => (u === 'BTC' ? [ALERT_UP, ALERT_DOWN] : []));
  autoBotsApi.signals.mockImplementation(async (id, { filter } = {}) => {
    if (Number(id) !== 1) return [];
    if (filter === 'traded') return SIGNALS.filter((s) => s.decision !== 'ignored');
    if (filter === 'ignored') return SIGNALS.filter((s) => s.decision === 'ignored');
    return SIGNALS;
  });
  autoBotsApi.create.mockResolvedValue({ id: 3, name: 'Nuevo', underlying: 'BTC', mode: 'shadow', template: 'alert_signal' });
  autoBotsApi.update.mockImplementation(async (id, data) => {
    if (data.alertIds) serverAlertIds[id] = data.alertIds;
    return { ok: true };
  });
  optionsStrategiesApi.get.mockImplementation(async (id) => {
    const b = withServerState(LIST.find((x) => x.id === Number(id)));
    return {
      ...b,
      alerts: undefined,
      kpis: { shadow: { pnl30dUsdt: b.pnl30d.shadow, cycles: 9, winRatePct: 66.67 }, live: {} },
      events: [],
    };
  });
  optionsStrategiesApi.setMode.mockImplementation(async (id, mode) => { serverModes[id] = mode; return { id, mode }; });
  optionsStrategiesApi.remove.mockResolvedValue({ ok: true });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('AutoTradingTab · escritorio', () => {
  it('carga la lista también en StrictMode (doble montaje de desarrollo)', async () => {
    render(<StrictMode><MemoryRouter><AutoTradingTab /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole('heading', { name: 'Momentum BTC' })).toBeTruthy();
  });

  it('lista → detalle con alertas, estructura, KPIs y señales; al pulsar otro bot carga su detalle', async () => {
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Momentum BTC' })).toBeTruthy();
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(1));
    await waitFor(() => expect(autoBotsApi.signals).toHaveBeenCalledWith(1, { limit: 100, filter: 'all' }));
    expect(screen.getByText(/Opera BTC cuando se dispara una de sus alertas · compra a favor de la señal/)).toBeTruthy();

    const list = screen.getByRole('list', { name: 'Bots' });
    const card = within(list).getByRole('button', { name: /Momentum BTC/ });
    expect(within(card).getByText('Alcista')).toBeTruthy();
    expect(within(card).getByText('Bajista')).toBeTruthy();
    expect(within(card).getByText('+214,60')).toBeTruthy();

    expect(screen.getByRole('button', { name: `Desvincular ${ALERT_UP.name}` })).toBeTruthy();
    const mapping = screen.getByRole('list', { name: 'Qué abre cada dirección' });
    expect(within(mapping).getByText('Comprar call')).toBeTruthy();
    expect(within(mapping).getByText('Comprar put')).toBeTruthy();
    expect(await screen.findByText('Ya hay una posición abierta (máx. 1)')).toBeTruthy();
    expect(screen.getByText('1 alcistas · 1 bajistas')).toBeTruthy();
    expect(screen.getByText('6 / 9')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sombra' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(list).getByRole('button', { name: /Breakout SOL/ }));
    expect(await screen.findByRole('heading', { name: 'Breakout SOL' })).toBeTruthy();
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(2));
    expect(within(screen.getByRole('list', { name: 'Qué abre cada dirección' })).getByText('Vender put')).toBeTruthy();
    expect(await screen.findByText('Todavía no ha llegado ninguna señal de sus alertas.')).toBeTruthy();
  });

  it('filtra las señales Todas / Operadas / Ignoradas', async () => {
    renderTab();
    expect(await screen.findByText('Ya hay una posición abierta (máx. 1)')).toBeTruthy();
    const filters = screen.getByRole('group', { name: 'Filtrar señales' });

    fireEvent.click(within(filters).getByRole('button', { name: 'Operadas' }));
    await waitFor(() => expect(autoBotsApi.signals).toHaveBeenCalledWith(1, { limit: 100, filter: 'traded' }));
    await waitFor(() => expect(screen.queryByText('Ya hay una posición abierta (máx. 1)')).toBeNull());
    expect(screen.getByText('Compra BTC-261024-70000-C a 905 · 0,05')).toBeTruthy();
    expect(within(filters).getByRole('button', { name: 'Operadas' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(filters).getByRole('button', { name: 'Ignoradas' }));
    await waitFor(() => expect(autoBotsApi.signals).toHaveBeenCalledWith(1, { limit: 100, filter: 'ignored' }));
    expect(await screen.findByText('Ya hay una posición abierta (máx. 1)')).toBeTruthy();
    expect(screen.queryByText('Compra BTC-261024-70000-C a 905 · 0,05')).toBeNull();
  });

  it('refresca las señales cada ~15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    await waitFor(() => expect(autoBotsApi.signals).toHaveBeenCalled());
    const before = autoBotsApi.signals.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS); });
    expect(autoBotsApi.signals.mock.calls.length).toBeGreaterThan(before);
  });

  it('pasar a Real abre la confirmación y sólo al aceptar envía confirm:true', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(screen.getByRole('radio', { name: 'Real' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activar modo Real' });
    expect(within(dialog).getByText(/El bot enviará/)).toBeTruthy();
    expect(optionsStrategiesApi.setMode).not.toHaveBeenCalled();

    const activate = within(dialog).getByRole('button', { name: 'Activar Real' });
    expect(activate.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Entiendo que se enviarán órdenes reales' }));
    fireEvent.click(activate);
    await waitFor(() => expect(optionsStrategiesApi.setMode).toHaveBeenCalledWith(1, 'live', { confirm: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Activar modo Real' })).toBeNull());
    expect(screen.getByRole('radio', { name: 'Real' }).getAttribute('aria-checked')).toBe('true');
  });

  it('pausar no pide confirmación', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(screen.getByRole('radio', { name: 'Pausado' }));
    await waitFor(() => expect(optionsStrategiesApi.setMode).toHaveBeenCalledWith(1, 'paused'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('nuevo bot: valida, la vista previa sigue a la estructura y envía el payload', async () => {
    renderTab({ underlying: 'BTC' });
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo bot' });
    await waitFor(() => expect(autoBotsApi.eligibleAlerts).toHaveBeenCalledWith('BTC'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear bot' }));
    expect(await within(dialog).findByText('Ponle un nombre')).toBeTruthy();
    expect(within(dialog).getByText('Elige al menos una alerta')).toBeTruthy();
    expect(autoBotsApi.create).not.toHaveBeenCalled();

    const preview = within(dialog).getByRole('list', { name: 'Qué abre cada dirección' });
    expect(within(preview).getByText('Comprar call')).toBeTruthy();
    expect(within(preview).getByText('Δ ≈ 0,35 · venc. ~7 d')).toBeTruthy();
    expect(within(dialog).getByText('Toma de ganancia')).toBeTruthy();
    expect(within(dialog).getByText('Prima máx. por operación')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Vender en contra/ }));
    expect(within(preview).getByText('Vender put')).toBeTruthy();
    expect(within(preview).getByText('Vender call')).toBeTruthy();
    expect(within(preview).getByText('Δ ≈ −0,25 · venc. ~7 d')).toBeTruthy();
    expect(within(dialog).getByText('Recomprar al')).toBeTruthy();
    expect(within(dialog).getByText('Margen máximo')).toBeTruthy();
    // + sube el delta un paso y la vista previa lo refleja al momento.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aumentar Delta objetivo' }));
    expect(within(preview).getByText('Δ ≈ 0,30 · venc. ~7 d')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Nombre'), { target: { value: 'Contra BTC' } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: new RegExp(ALERT_DOWN.name) }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Solo cerrar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear bot' }));

    await waitFor(() => expect(autoBotsApi.create).toHaveBeenCalledTimes(1));
    expect(autoBotsApi.create.mock.calls[0][0]).toEqual({
      name: 'Contra BTC',
      underlying: 'BTC',
      alertIds: [12],
      params: {
        structure: 'sell_against', targetDelta: 0.3, expiryDays: 7, quantity: 0.01, onOpposite: 'close',
        takeProfitPct: 50, stopLossPct: 200, exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4,
        contractCount: 1, capitalUsdt: null,
        takeProfitMode: 'fixed', tpAtrMultiplier: 1, tpHorizonHours: 4,
      },
      limits: { maxMarginUsdt: 1000 },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo bot' })).toBeNull());
  });

  it('sin alertas elegibles muestra el enlace a Alertas', async () => {
    renderTab({ underlying: 'BTC' });
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo bot' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'ETH' }));
    await waitFor(() => expect(autoBotsApi.eligibleAlerts).toHaveBeenCalledWith('ETH'));
    expect(await within(dialog).findByText(/No tienes alertas alcistas o bajistas de ETH/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Crear o editar alertas' }).getAttribute('href')).toBe('/alertas');
  });

  it('editar envía PUT sin subyacente; desvincular una alerta envía las restantes', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByRole('button', { name: `Desvincular ${ALERT_UP.name}` }));
    await waitFor(() => expect(autoBotsApi.update).toHaveBeenCalledWith(1, { alertIds: [12] }));

    fireEvent.click(screen.getByRole('button', { name: 'Editar bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar bot' });
    fireEvent.change(within(dialog).getByLabelText('Nombre'), { target: { value: 'Momentum BTC v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(autoBotsApi.update).toHaveBeenCalledTimes(2));
    const [id, payload] = autoBotsApi.update.mock.calls[1];
    expect(id).toBe(1);
    expect(payload.underlying).toBeUndefined();
    expect(payload).toMatchObject({ name: 'Momentum BTC v2', alertIds: [12], params: { structure: 'buy_with', quantity: 0.05 } });
  });

  it('eliminar pide confirmación y llama a DELETE', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar bot' });
    expect(optionsStrategiesApi.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(optionsStrategiesApi.remove).toHaveBeenCalledWith(1));
  });
});

const POSITION = { id: 5, mode: 'shadow', symbol: 'BTC-261024-70000-C', side: 'BUY', quantity: 0.05, entryPrice: 900, mark: 950, closedAt: null };
const ENTRY_ORDER = { id: 9, purpose: 'standard', action: 'open', symbol: 'BTC-261024-72000-C', side: 'BUY', price: 500, quantity: 0.05, executedQty: 0, status: 'active', cancelRequested: false, deadlineAt: NOW + 3600e3 };
const EXIT_ORDER = { id: 12, purpose: 'standard', action: 'close', symbol: 'BTC-261024-70000-C', side: 'SELL', price: 940, quantity: 0.05, executedQty: 0, status: 'active', cancelRequested: false, deadlineAt: NOW + 3600e3 };
const TP_ORDER = { id: 10, purpose: 'take_profit', action: 'close', symbol: 'BTC-261024-70000-C', side: 'SELL', price: 1600, quantity: 0.05, executedQty: 0, status: 'active', cancelRequested: false, deadlineAt: NOW + 3600e3 };

function withActivity(extra = {}) {
  const base = optionsStrategiesApi.get.getMockImplementation();
  optionsStrategiesApi.get.mockImplementation(async (id) => ({ ...(await base(id)), ...extra }));
}

describe('AutoTradingTab · cierre manual y cancelación', () => {
  it('«Cerrar todo» pide confirmación, envía positionIds undefined una sola vez y muestra el resultado', async () => {
    withActivity({ positions: [POSITION] });
    let resolveClose;
    autoBotsApi.close.mockImplementation(() => new Promise((r) => { resolveClose = r; }));
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar todo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar todas las posiciones' });
    expect(within(dialog).getByText(/sombra/i)).toBeTruthy();
    expect(within(dialog).queryByText(/orden LIMIT real/)).toBeNull();
    expect(autoBotsApi.close).not.toHaveBeenCalled();

    const confirm = within(dialog).getByRole('button', { name: 'Confirmar cierre' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(autoBotsApi.close).toHaveBeenCalledTimes(1));
    expect(autoBotsApi.close).toHaveBeenCalledWith(1, { positionIds: undefined });
    expect(within(dialog).getByRole('button', { name: /Cerrando/ }).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /Cerrando/ }));
    expect(autoBotsApi.close).toHaveBeenCalledTimes(1);

    await act(async () => { resolveClose({ status: 'closed', detail: 'Cierre manual' }); });
    expect(await within(dialog).findByText(/Cierre manual/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Listo' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cerrar todas las posiciones' })).toBeNull());
  });

  it('en Real «Cerrar» de una posición avisa de la orden LIMIT real y explica si no se envió', async () => {
    serverModes[1] = 'live';
    withActivity({ positions: [{ ...POSITION, mode: 'live' }] });
    autoBotsApi.close.mockResolvedValue({ status: 'not_submitted', detail: 'Sin precio para BTC-261024-70000-C' });
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar BTC-261024-70000-C' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar posición' });
    expect(within(dialog).getByText(/Se enviará una orden LIMIT real a Binance/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar cierre' }));
    await waitFor(() => expect(autoBotsApi.close).toHaveBeenCalledWith(1, { positionIds: [5] }));
    expect(await within(dialog).findByText(/Sin precio para BTC-261024-70000-C/)).toBeTruthy();
  });

  it('un error del servidor (cierre en curso) se muestra en la confirmación', async () => {
    withActivity({ positions: [POSITION] });
    autoBotsApi.close.mockRejectedValue(Object.assign(new Error('Ya hay un cierre en curso para esta posición'), { code: 'CLOSE_PENDING' }));
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cerrar todo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar todas las posiciones' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar cierre' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/cierre en curso/);
  });

  it('«Cancelar» pide la cancelación de una entrada pendiente; ni el TP ni las salidas tienen botón', async () => {
    serverModes[1] = 'live';
    withActivity({ pendingOrders: [ENTRY_ORDER, TP_ORDER, EXIT_ORDER] });
    let resolveCancel;
    autoBotsApi.cancelOrder.mockImplementation(() => new Promise((r) => { resolveCancel = r; }));
    renderTab();
    await screen.findByRole('heading', { name: 'Momentum BTC' });
    const btn = await screen.findByRole('button', { name: 'Cancelar orden 9' });
    expect(screen.queryByRole('button', { name: 'Cancelar orden 10' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancelar orden 12' })).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(autoBotsApi.cancelOrder).toHaveBeenCalledTimes(1));
    expect(autoBotsApi.cancelOrder).toHaveBeenCalledWith(1, 9);
    expect(screen.getByRole('button', { name: 'Cancelar orden 9' }).disabled).toBe(true);
    await act(async () => { resolveCancel({ id: 9, cancelRequested: true }); });
    expect(await screen.findByText(/Cancelación solicitada/)).toBeTruthy();
  });
});

describe('AutoTradingTab · móvil', () => {
  it('«Última señal», tarjetas y FAB; el detalle se abre a pantalla completa y «Volver» regresa', async () => {
    mockViewport(true);
    renderTab();
    const last = await screen.findByRole('button', { name: /Última señal/ });
    expect(within(last).getByText('Alcista · BTC')).toBeTruthy();
    expect(within(last).getByText(/Momentum BTC · Abrió: Compra BTC-261024-70000-C a 905/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nuevo bot' })).toBeTruthy();
    expect(optionsStrategiesApi.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Breakout SOL/ }));
    const detail = await screen.findByRole('dialog', { name: 'Breakout SOL' });
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(2));
    expect(within(detail).getByRole('radiogroup', { name: 'Modo de ejecución' })).toBeTruthy();
    expect(within(detail).getByText('Al recibir la señal')).toBeTruthy();
    expect(within(detail).getByText('Vender put')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: /Alertas, salidas y riesgo/ })).toBeTruthy();
    expect(within(detail).getByRole('group', { name: 'Filtrar señales' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(detail).getByRole('button', { name: 'Volver' }));
    expect(screen.queryByRole('dialog', { name: 'Breakout SOL' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('tocar «Última señal» abre su bot con las señales en tarjetas', async () => {
    mockViewport(true);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Última señal/ }));
    const detail = await screen.findByRole('dialog', { name: 'Momentum BTC' });
    const cards = await within(detail).findByRole('list', { name: 'Señales' });
    expect(within(cards).getByText('Alcista · 85 %')).toBeTruthy();
    expect(within(cards).getByText('Ignorada')).toBeTruthy();
  });

  it('el FAB abre el formulario como hoja inferior', async () => {
    mockViewport(true);
    renderTab({ underlying: 'BTC' });
    fireEvent.click(await screen.findByRole('button', { name: 'Nuevo bot' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nuevo bot' });
    expect(within(sheet).getByRole('radiogroup', { name: 'Estructura' })).toBeTruthy();
    expect(await within(sheet).findByRole('checkbox', { name: new RegExp(ALERT_UP.name) })).toBeTruthy();
  });
});
