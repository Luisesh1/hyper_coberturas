import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StrategiesTab, { DETAIL_POLL_MS } from './StrategiesTab';
import { validateStrategyForm } from './StrategyForm';
import { optionsStrategiesApi } from '../optionsAutomationApi';

vi.mock('../optionsAutomationApi', () => ({
  optionsStrategiesApi: {
    listTemplates: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    setMode: vi.fn(),
    remove: vi.fn(),
  },
  optionsBacktestsApi: { create: vi.fn(), list: vi.fn(), get: vi.fn() },
}));

const TEMPLATES = [
  {
    id: 'short_strangle',
    label: 'Strangle corto',
    defaultParams: { deltaTarget: 0.2, dte: 7, ivMinPct: 45, onlyFridays: true },
    paramSchema: [
      { key: 'deltaTarget', label: 'Delta objetivo', type: 'number', min: 0.05, max: 0.5, step: 0.05 },
      { key: 'dte', label: 'Días a vencimiento', type: 'integer', min: 1, max: 60 },
      { key: 'ivMinPct', label: 'IV mínima', type: 'number', min: 0, max: 300, unit: '%' },
      { key: 'onlyFridays', label: 'Sólo viernes', type: 'boolean' },
    ],
  },
  { id: 'covered_call', label: 'Call cubierta', defaultParams: { deltaTarget: 0.25 }, paramSchema: [{ key: 'deltaTarget', label: 'Delta objetivo', type: 'number', min: 0.05, max: 0.5 }] },
];

const LIST = [
  { id: 1, name: 'Strangle semanal BTC', template: 'short_strangle', underlying: 'BTC', mode: 'shadow', status: '2 patas abiertas', pnl30d: { shadow: 412.8, live: null } },
  { id: 2, name: 'Covered call ETH', template: 'covered_call', underlying: 'ETH', mode: 'paused', status: 'Esperando entrada', pnl30d: { shadow: 96.2, live: 10 } },
];

const DETAIL_1 = {
  ...LIST[0],
  params: { deltaTarget: 0.2, dte: 7, ivMinPct: 45, onlyFridays: true },
  limits: { maxMarginUsdt: 2000 },
  kpis: { pnlShadow: 412.8, pnlLive: null, executionDriftPct: -3.1, premiumUsdt: 1020, marginUsedUsdt: 1240 },
  equity: [
    { t: 1760000000000, shadow: 0, live: null },
    { t: 1760086400000, shadow: 120, live: null },
    { t: 1760172800000, shadow: 412.8, live: null },
  ],
  events: [
    { id: 10, mode: 'shadow', action: 'open', detail: 'Venta BTC-261017-72000-C y BTC-261017-64000-P', premium_usdt: 1052.5, created_at: 1760172800000 },
    { id: 11, mode: 'shadow', action: 'hold', detail: 'Prima al 61 %', premium_usdt: null, created_at: 1760086400000 },
  ],
};

const DETAIL_2 = { ...LIST[1], params: { deltaTarget: 0.25 }, limits: {}, kpis: {}, equity: [], events: [] };

const originalMatchMedia = window.matchMedia;
function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

// Servidor de mentira: el modo cambiado con setMode se refleja en list/get.
let serverModes;

beforeEach(() => {
  mockViewport(false);
  serverModes = { 1: 'shadow', 2: 'paused' };
  optionsStrategiesApi.listTemplates.mockResolvedValue(TEMPLATES);
  optionsStrategiesApi.list.mockImplementation(async () => LIST.map((s) => ({ ...s, mode: serverModes[s.id] })));
  optionsStrategiesApi.get.mockImplementation(async (id) => {
    const d = Number(id) === 1 ? DETAIL_1 : DETAIL_2;
    return { ...d, mode: serverModes[d.id] };
  });
  optionsStrategiesApi.setMode.mockImplementation(async (id, mode) => { serverModes[id] = mode; return { id, mode }; });
  optionsStrategiesApi.create.mockResolvedValue({ id: 3, name: 'Nueva', template: 'short_strangle', underlying: 'BTC', mode: 'paused' });
  optionsStrategiesApi.update.mockResolvedValue({ ok: true });
  optionsStrategiesApi.remove.mockResolvedValue({ ok: true });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('StrategiesTab · escritorio', () => {
  it('lista → selecciona la primera y muestra su detalle; al pulsar otra carga su detalle', async () => {
    render(<StrategiesTab />);
    expect(await screen.findByRole('heading', { name: 'Strangle semanal BTC' })).toBeTruthy();
    // El encabezado sale de la lista; el detalle se pide en un efecto posterior.
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Prima al 61 %')).toBeTruthy();
    expect(screen.getByText('Plantilla «Strangle corto» · BTC · evalúa cada 5 min · 2 patas abiertas')).toBeTruthy();
    expect(screen.getByText('1.240 / 2.000')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sombra' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Covered call ETH/ }));
    expect(await screen.findByRole('heading', { name: 'Covered call ETH' })).toBeTruthy();
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(2));
    expect(await screen.findByText('Todavía no hay decisiones registradas.')).toBeTruthy();
  });

  it('pasar a Real abre la confirmación y sólo al aceptar envía confirm:true', async () => {
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });

    fireEvent.click(screen.getByRole('radio', { name: 'Real' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activar modo Real' });
    expect(optionsStrategiesApi.setMode).not.toHaveBeenCalled();

    const activate = within(dialog).getByRole('button', { name: 'Activar Real' });
    expect(activate.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Entiendo que se enviarán órdenes reales' }));
    expect(activate.disabled).toBe(false);
    fireEvent.click(activate);

    await waitFor(() => expect(optionsStrategiesApi.setMode).toHaveBeenCalledWith(1, 'live', { confirm: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Activar modo Real' })).toBeNull());
    expect(screen.getByRole('radio', { name: 'Real' }).getAttribute('aria-checked')).toBe('true');
  });

  it('cancelar la confirmación no cambia el modo', async () => {
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    fireEvent.click(screen.getByRole('radio', { name: 'Real' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activar modo Real' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Activar modo Real' })).toBeNull();
    expect(optionsStrategiesApi.setMode).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Sombra' }).getAttribute('aria-checked')).toBe('true');
  });

  it('muestra el error del servidor y enlaza a Configuración si faltan credenciales', async () => {
    optionsStrategiesApi.setMode.mockRejectedValueOnce(Object.assign(new Error('Faltan credenciales de Binance Opciones'), { code: 'OPTIONS_CREDENTIALS_MISSING' }));
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    fireEvent.click(screen.getByRole('radio', { name: 'Real' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activar modo Real' });
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Activar Real' }));

    expect(await within(dialog).findByText(/Faltan credenciales de Binance Opciones/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Configura tu API key/ }).getAttribute('href')).toBe('/config');
    expect(screen.getByRole('radio', { name: 'Sombra' }).getAttribute('aria-checked')).toBe('true');
  });

  it('pausar no pide confirmación', async () => {
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    fireEvent.click(screen.getByRole('radio', { name: 'Pausada' }));
    await waitFor(() => expect(optionsStrategiesApi.setMode).toHaveBeenCalledWith(1, 'paused'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('nueva estrategia: valida, y envía nombre, plantilla, subyacente y parámetros', async () => {
    render(<StrategiesTab underlying="ETH" />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    fireEvent.click(screen.getByRole('button', { name: 'Nueva estrategia' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva estrategia' });

    // Sin nombre no se envía.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear estrategia' }));
    expect(await within(dialog).findByText('Ponle un nombre')).toBeTruthy();
    expect(optionsStrategiesApi.create).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Nombre'), { target: { value: 'Mi strangle' } });
    // Stepper: + sube Delta objetivo un paso (0,2 → 0,25).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aumentar Delta objetivo' }));
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Sólo viernes' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear estrategia' }));

    await waitFor(() => expect(optionsStrategiesApi.create).toHaveBeenCalledTimes(1));
    expect(optionsStrategiesApi.create.mock.calls[0][0]).toEqual({
      name: 'Mi strangle',
      template: 'short_strangle',
      underlying: 'ETH',
      params: { deltaTarget: 0.25, dte: 7, ivMinPct: 45, onlyFridays: false },
      limits: {},
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva estrategia' })).toBeNull());
  });

  it('eliminar pide confirmación y llama a DELETE', async () => {
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar estrategia' }));
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar estrategia' });
    expect(optionsStrategiesApi.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(optionsStrategiesApi.remove).toHaveBeenCalledWith(1));
  });

  it('refresca el detalle cada 30 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<StrategiesTab />);
    await screen.findByRole('heading', { name: 'Strangle semanal BTC' });
    const before = optionsStrategiesApi.get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(DETAIL_POLL_MS); });
    expect(optionsStrategiesApi.get.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('StrategiesTab · móvil', () => {
  it('tiles + tarjetas + FAB; el detalle se abre a pantalla completa y «Volver» regresa', async () => {
    mockViewport(true);
    render(<StrategiesTab />);
    expect(await screen.findByText('Real · 30d')).toBeTruthy();
    expect(screen.getByText('Sombra · 30d')).toBeTruthy();
    expect(screen.getByText('+509,00')).toBeTruthy(); // 412,8 + 96,2
    expect(screen.getByRole('button', { name: 'Nueva' })).toBeTruthy();
    // En móvil no se autoselecciona ni se pide detalle hasta tocar una tarjeta.
    expect(optionsStrategiesApi.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Nueva estrategia' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Strangle semanal BTC/ }));
    const detail = await screen.findByRole('dialog', { name: 'Strangle semanal BTC' });
    await waitFor(() => expect(optionsStrategiesApi.get).toHaveBeenCalledWith(1));
    expect(within(detail).getByRole('radiogroup', { name: 'Modo de ejecución' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: /Editar parámetros/ })).toBeTruthy();
    expect(await within(detail).findByText('Últimas decisiones')).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(detail).getByRole('button', { name: 'Volver' }));
    expect(screen.queryByRole('dialog', { name: 'Strangle semanal BTC' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('el FAB abre el formulario como hoja inferior', async () => {
    mockViewport(true);
    render(<StrategiesTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nueva' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nueva estrategia' });
    expect(within(sheet).getByRole('radiogroup', { name: 'Subyacente' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Disminuir Delta objetivo' })).toBeTruthy();
  });
});

describe('validateStrategyForm', () => {
  const schema = TEMPLATES[0].paramSchema;
  it('marca nombre vacío, parámetros fuera de rango y límites negativos', () => {
    const errors = validateStrategyForm({
      name: '  ',
      template: 'short_strangle',
      underlying: 'BTC',
      params: { deltaTarget: 0.9, dte: 0, ivMinPct: 45, onlyFridays: true },
      maxMarginUsdt: -5,
      maxDailyLossUsdt: null,
    }, schema);
    expect(errors).toEqual({
      name: 'Ponle un nombre',
      maxMarginUsdt: 'No puede ser negativo',
      params: { deltaTarget: 'Máximo 0,5', dte: 'Mínimo 1' },
    });
  });
});
