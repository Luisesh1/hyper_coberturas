import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AlertsPage from './AlertsPage';
import { alertsApi, request } from '../../services/api';
import { PRESETS } from './lib/presets';
import { buildAlertBotUsage } from './lib/autoBots';
import { botOpensLabel, matchesDirectionFilter, telegramTitle } from './lib/direction';

vi.mock('../../services/api', () => ({
  alertsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
  request: vi.fn(),
}));

const addNotification = vi.fn();
vi.mock('../../context/TradingContext', () => ({
  useTradingContext: () => ({ addNotification }),
}));

const RULES = [{
  weight: 1,
  conditions: [{
    indicatorType: 'macd',
    indicatorParams: { fast: 12, slow: 26, signal: 9 },
    timeframe: '15m',
    operandSeries: 'macd',
    operator: 'cross_up',
    operand: { kind: 'constant', value: 0 },
  }],
  joiners: [],
}];

function alert(id, name, direction, extra = {}) {
  return {
    id,
    name,
    direction,
    isActive: true,
    thresholdPercent: 70,
    cooldownSeconds: 900,
    telegramEnabled: true,
    datasource: 'binance',
    assetList: ['BTCUSDT'],
    rules: RULES,
    ...extra,
  };
}

const ALERTS = [
  alert(1, 'BTC · MACD cruce alcista 15m', 'bullish'),
  alert(2, 'BTC · MACD cruce bajista 15m', 'bearish'),
  alert(3, 'Volumen anómalo', 'neutral'),
  // Alerta vieja sin campo direction → se trata como neutral.
  alert(4, 'Alerta legacy', undefined),
];

const BOTS = [
  { id: 70, name: 'Momentum BTC', mode: 'shadow', params: { alertIds: [1, 2], structure: 'buy_with' }, alerts: [{ id: 1 }, { id: 2 }] },
];

const originalMatchMedia = window.matchMedia;
function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsPage />
    </MemoryRouter>,
  );
}

const listItem = (name) => screen.getByText(name).closest('button');

beforeEach(() => {
  mockViewport(false);
  vi.clearAllMocks();
  alertsApi.list.mockResolvedValue(ALERTS);
  alertsApi.create.mockImplementation(async (payload) => ({ id: 99, ...payload }));
  alertsApi.update.mockImplementation(async (id, payload) => ({ id, ...payload }));
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === '/options/auto-bots') return BOTS;
    throw new Error(`unexpected ${method} ${path}`);
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('lib de dirección', () => {
  it('las plantillas traen dirección por defecto', () => {
    const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
    expect(byId.rsi_oversold.direction).toBe('bullish');
    expect(byId.rsi_overbought.direction).toBe('bearish');
    expect(byId.macd_bull_cross.direction).toBe('bullish');
    expect(byId.macd_bear_cross.direction).toBe('bearish');
    expect(byId.golden_cross.direction).toBe('bullish');
    expect(byId.squeeze_release.direction).toBe('neutral');
    expect(byId.rsi_zone.direction).toBe('neutral');
    for (const p of PRESETS) expect(p.build().direction).toBe(p.direction);
  });

  it('el cruce bajista usa cross_down', () => {
    const built = PRESETS.find((p) => p.id === 'macd_bear_cross').build();
    expect(built.rules[0].conditions[0].operator).toBe('cross_down');
  });

  it('cuenta los bots por alerta desde params.alertIds y alerts', () => {
    const usage = buildAlertBotUsage([
      { id: 1, name: 'A', mode: 'shadow', params: { alertIds: [5] } },
      { id: 2, name: 'B', mode: 'live', alerts: [{ id: 5 }, { id: 6 }], params: { structure: 'sell_against' } },
    ]);
    expect(usage.get(5).map((b) => b.name)).toEqual(['A', 'B']);
    expect(usage.get(6)[0].structure).toBe('sell_against');
    expect(usage.has(7)).toBe(false);
    expect(buildAlertBotUsage(null).size).toBe(0);
  });

  it('encabezado de Telegram y qué abre cada estructura', () => {
    expect(telegramTitle('bullish', 'X')).toBe('🟢 ALCISTA · X');
    expect(telegramTitle('bearish', 'X')).toBe('🔴 BAJISTA · X');
    expect(telegramTitle('neutral', 'X')).toBe('🔔 X');
    expect(botOpensLabel('buy_with', 'bullish')).toBe('abre calls');
    expect(botOpensLabel('buy_with', 'bearish')).toBe('abre puts');
    expect(botOpensLabel('sell_against', 'bullish')).toBe('vende puts');
    expect(botOpensLabel('sell_against', 'bearish')).toBe('vende calls');
    expect(matchesDirectionFilter({}, 'neutral')).toBe(true);
    expect(matchesDirectionFilter({ direction: 'bullish' }, 'bearish')).toBe(false);
  });
});

describe('AlertsPage · dirección (escritorio)', () => {
  it('muestra el chip de dirección en la lista y filtra por dirección', async () => {
    renderPage();
    await screen.findByText('Alerta legacy');

    expect(within(listItem('BTC · MACD cruce alcista 15m')).getByTestId('direction-chip').textContent).toContain('Alcista');
    expect(within(listItem('BTC · MACD cruce bajista 15m')).getByTestId('direction-chip').textContent).toContain('Bajista');
    expect(within(listItem('Alerta legacy')).getByTestId('direction-chip').textContent).toContain('Neutral');

    const filters = screen.getByRole('group', { name: 'Filtrar por dirección' });
    fireEvent.click(within(filters).getByRole('button', { name: /Alcistas/ }));
    expect(screen.getByText('BTC · MACD cruce alcista 15m')).toBeTruthy();
    expect(screen.queryByText('BTC · MACD cruce bajista 15m')).toBeNull();

    fireEvent.click(within(filters).getByRole('button', { name: /Neutrales/ }));
    expect(screen.getByText('Volumen anómalo')).toBeTruthy();
    expect(screen.getByText('Alerta legacy')).toBeTruthy();
    expect(screen.queryByText('BTC · MACD cruce alcista 15m')).toBeNull();

    fireEvent.click(within(filters).getByRole('button', { name: 'Todas' }));
    expect(screen.getByText('BTC · MACD cruce bajista 15m')).toBeTruthy();
  });

  it('el selector cambia la dirección, actualiza la vista previa de Telegram y se envía al crear', async () => {
    renderPage();
    await screen.findByText('Alerta legacy');

    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    expect(within(group).getByRole('radio', { name: /Neutral/ }).getAttribute('aria-checked')).toBe('true');

    fireEvent.change(screen.getByPlaceholderText('Ej: BTC RSI sobreventa'), { target: { value: 'Mi alerta' } });
    fireEvent.click(within(group).getByRole('radio', { name: /Bajista/ }));
    expect(within(group).getByRole('radio', { name: /Bajista/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('telegram-preview').textContent).toContain('🔴 BAJISTA · Mi alerta');

    // Teclado: la flecha izquierda pasa de Bajista a Alcista.
    fireEvent.keyDown(within(group).getByRole('radio', { name: /Bajista/ }), { key: 'ArrowLeft' });
    expect(within(group).getByRole('radio', { name: /Alcista/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('telegram-preview').textContent).toContain('🟢 ALCISTA · Mi alerta');

    fireEvent.click(screen.getByRole('button', { name: 'Crear alerta' }));
    await waitFor(() => expect(alertsApi.create).toHaveBeenCalledTimes(1));
    expect(alertsApi.create.mock.calls[0][0].direction).toBe('bullish');
  });

  it('una plantilla aplica su dirección por defecto', async () => {
    renderPage();
    await screen.findByText('Alerta legacy');
    fireEvent.click(screen.getByRole('button', { name: /RSI sobrecompra/ }));
    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    expect(within(group).getByRole('radio', { name: /Bajista/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('carga la dirección de la alerta y muestra «Usada por» con sus bots', async () => {
    renderPage();
    await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/options/auto-bots'));
    await waitFor(() => expect(within(listItem('BTC · MACD cruce alcista 15m')).getByText('Usada por 1 bot')).toBeTruthy());
    expect(within(listItem('Volumen anómalo')).getByText('Sin bots')).toBeTruthy();
    expect(screen.getByText('usadas por bots').previousSibling.textContent).toContain('2');

    fireEvent.click(listItem('BTC · MACD cruce bajista 15m'));
    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    expect(within(group).getByRole('radio', { name: /Bajista/ }).getAttribute('aria-checked')).toBe('true');
    const usedBy = screen.getByTestId('used-by');
    expect(usedBy.textContent).toContain('Usada por 1 bot');
    expect(within(usedBy).getByRole('link', { name: /Momentum BTC/ }).getAttribute('href')).toBe('/opciones?tab=auto');
    expect(usedBy.textContent).toContain('Sombra · abre puts');
  });

  it('avisa al pasar a Neutral una alerta usada por bots y pide confirmación al guardar', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await waitFor(() => expect(within(listItem('BTC · MACD cruce alcista 15m')).getByText('Usada por 1 bot')).toBeTruthy());
    fireEvent.click(listItem('BTC · MACD cruce alcista 15m'));

    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    fireEvent.click(within(group).getByRole('radio', { name: /Neutral/ }));
    expect(screen.getByRole('alert').textContent).toContain('Esta alerta la usa «Momentum BTC». Si la pasas a Neutral, el bot dejará de operarla.');

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(alertsApi.update).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(alertsApi.update).toHaveBeenCalledTimes(1));
    expect(alertsApi.update.mock.calls[0][1].direction).toBe('neutral');
  });

  it('sin aviso al pasar a Neutral una alerta sin bots', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    alertsApi.list.mockResolvedValue([alert(8, 'Sin bots alcista', 'bullish')]);
    renderPage();
    await waitFor(() => expect(within(listItem('Sin bots alcista')).getByText('Sin bots')).toBeTruthy());
    fireEvent.click(listItem('Sin bots alcista'));
    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    fireEvent.click(within(group).getByRole('radio', { name: /Neutral/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(alertsApi.update).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('si /options/auto-bots falla, oculta «Usada por» sin mostrar error', async () => {
    request.mockRejectedValue(new Error('404'));
    renderPage();
    await screen.findByText('Alerta legacy');
    await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/options/auto-bots'));
    fireEvent.click(listItem('BTC · MACD cruce alcista 15m'));
    expect(screen.queryByTestId('used-by')).toBeNull();
    expect(screen.queryByText(/Usada por/)).toBeNull();
    expect(screen.queryByText('usadas por bots')).toBeNull();
    expect(addNotification).not.toHaveBeenCalledWith('error', expect.anything());
  });
});

describe('AlertsPage · dirección (móvil)', () => {
  beforeEach(() => mockViewport(true));

  it('lista a pantalla completa → editor con volver, selector apilado y CTA fijo', async () => {
    renderPage();
    await screen.findByText('Alerta legacy');
    expect(screen.queryByRole('radiogroup', { name: 'Dirección de la señal' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Filtrar por dirección' })).toBeTruthy();

    fireEvent.click(listItem('BTC · MACD cruce alcista 15m'));
    expect(screen.getByRole('heading', { name: 'Editar alerta' })).toBeTruthy();
    expect(screen.queryByText('Alerta legacy')).toBeNull();
    expect(document.body.classList.contains('tv-mobile-chrome')).toBe(true);

    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    const bullish = within(group).getByRole('radio', { name: /Alcista/ });
    expect(bullish.getAttribute('aria-checked')).toBe('true');
    expect(bullish.textContent).toContain('Señal de subida · los bots abren a favor');
    expect(bullish.querySelector('[data-direction-icon="bullish"]')).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Guardar cambios' }).parentElement.className).toMatch(/mobileCtaBar/);

    fireEvent.click(screen.getByRole('button', { name: 'Volver a alertas' }));
    expect(screen.getByText('Alerta legacy')).toBeTruthy();
    expect(document.body.classList.contains('tv-mobile-chrome')).toBe(false);
  });

  it('«Nueva alerta» abre el editor vacío con dirección Neutral', async () => {
    renderPage();
    await screen.findByText('Alerta legacy');
    fireEvent.click(screen.getByRole('button', { name: '+ Nueva alerta' }));
    expect(screen.getByRole('heading', { name: 'Nueva alerta' })).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Dirección de la señal' });
    expect(within(group).getByRole('radio', { name: /Neutral/ }).getAttribute('aria-checked')).toBe('true');
  });
});
