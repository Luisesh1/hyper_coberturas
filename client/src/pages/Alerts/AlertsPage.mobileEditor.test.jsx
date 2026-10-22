import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AlertsPage from './AlertsPage';
import { alertsApi, request } from '../../services/api';

vi.mock('../../services/api', () => ({
  alertsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn() },
  request: vi.fn(),
}));
const addNotification = vi.fn();
vi.mock('../../context/TradingContext', () => ({
  useTradingContext: () => ({ addNotification }),
}));

const ALERT = {
  id: 1, name: 'RSI bajo', direction: 'bullish', isActive: true, thresholdPercent: 70,
  cooldownSeconds: 900, telegramEnabled: true, datasource: 'binance', assetList: ['BTCUSDT'],
  rules: [{ label: 'sobreventa', weight: 1, joiners: [], conditions: [{ indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } }] }],
};

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.clearAllMocks();
  alertsApi.list.mockResolvedValue([ALERT]);
  alertsApi.update.mockImplementation(async (id, payload) => ({ id, ...payload }));
  request.mockResolvedValue([]);
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

const renderPage = () => render(<MemoryRouter><AlertsPage /></MemoryRouter>);

async function openEditor() {
  renderPage();
  fireEvent.click(await screen.findByText('RSI bajo'));
}

describe('AlertsPage · editor móvil', () => {
  it('abre el editor móvil con las reglas como tarjetas', async () => {
    await openEditor();
    expect(screen.getByRole('heading', { name: 'Editar alerta' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Reglas (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Regla 1/ }).textContent).toContain('«sobreventa» · peso 1');
    expect(document.body.classList.contains('tv-mobile-chrome')).toBe(true);
  });

  it('tocar el umbral marca cambios sin guardar y habilita Guardar', async () => {
    await openEditor();
    const save = screen.getByRole('button', { name: 'Guardar cambios' });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Subir umbral' }));
    expect(screen.getByText('75 %')).toBeTruthy();
    expect(screen.getByText(/Cambios sin guardar/)).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(alertsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ thresholdPercent: 75 }));
  });

  it('tocar una regla abre su editor y «+ Añadir regla» abre la nueva', async () => {
    await openEditor();
    expect(screen.queryByTestId('rule-editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Regla 1/ }));
    expect(screen.getByTestId('rule-editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '+ Añadir regla' }));
    expect(screen.getByRole('heading', { name: 'Reglas (2)' })).toBeTruthy();
    const editors = screen.getAllByTestId('rule-editor');
    expect(editors).toHaveLength(1);
    expect(within(editors[0]).getByText(/#2/)).toBeTruthy();
  });

  it('Probar usa dryRun y abre la hoja del resultado', async () => {
    alertsApi.test.mockResolvedValue({ results: [{ asset: 'BTCUSDT', lowestTimeframe: '15m', score: 55, threshold: 70, wouldTrigger: false, rules: [] }] });
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    const dialog = await screen.findByRole('dialog');
    expect(alertsApi.test).toHaveBeenCalledWith(1, { dryRun: true });
    expect(within(dialog).getByText(/55\.0% \/ 70%/)).toBeTruthy();
    // El resultado solo va en la hoja, no también en línea.
    expect(screen.queryByText('Resultado del test')).toBeNull();
    expect(screen.getAllByText(/55\.0% \/ 70%/)).toHaveLength(1);
  });

  it('el interruptor Activa de una alerta guardada guarda al momento', async () => {
    await openEditor();
    const sw = screen.getByRole('switch', { name: 'Activa' });
    fireEvent.click(sw);
    await waitFor(() => expect(alertsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ isActive: false, name: 'RSI bajo' })));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Activa' }).getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByText(/Cambios sin guardar/)).toBeNull();
  });

  it('si falla el interruptor, sigue Activa y avisa', async () => {
    alertsApi.update.mockRejectedValue(new Error('boom'));
    await openEditor();
    fireEvent.click(screen.getByRole('switch', { name: 'Activa' }));
    await waitFor(() => expect(addNotification).toHaveBeenCalledWith('error', expect.stringContaining('boom')));
    expect(screen.getByRole('switch', { name: 'Activa' }).getAttribute('aria-checked')).toBe('true');
  });

  it('en una alerta nueva, el interruptor Activa no guarda', async () => {
    renderPage();
    await screen.findByText('RSI bajo');
    fireEvent.click(screen.getByRole('button', { name: '+ Nueva alerta' }));
    const sw = screen.getByRole('switch', { name: 'Activa' });
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(alertsApi.update).not.toHaveBeenCalled();
    expect(alertsApi.create).not.toHaveBeenCalled();
  });

  it('cambiar a modo JSON y volver cierra la regla abierta', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /Regla 1/ }));
    expect(screen.getByTestId('rule-editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Modo JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Modo visual' }));
    expect(screen.queryByTestId('rule-editor')).toBeNull();
  });
});
