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
  rules: [{ weight: 1, joiners: [], conditions: [{ indicatorType: 'rsi', indicatorParams: { length: 14 }, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } }] }],
};

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.clearAllMocks();
  alertsApi.list.mockResolvedValue([ALERT]);
  request.mockResolvedValue([]);
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

const renderPage = () => render(<MemoryRouter><AlertsPage /></MemoryRouter>);

describe('AlertsPage · lista móvil', () => {
  it('el interruptor envía la alerta completa con isActive invertido', async () => {
    alertsApi.update.mockResolvedValue({ ...ALERT, isActive: false });
    renderPage();
    const sw = await screen.findByRole('switch');
    fireEvent.click(sw);
    await waitFor(() => expect(alertsApi.update).toHaveBeenCalled());
    const [id, payload] = alertsApi.update.mock.calls[0];
    expect(id).toBe(1);
    expect(payload).toMatchObject({ name: 'RSI bajo', isActive: false, direction: 'bullish', thresholdPercent: 70, assetList: ['BTCUSDT'] });
    expect(payload.rules[0].conditions[0].timeframe).toBe('15m');
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'));
  });

  it('si falla, revierte y avisa', async () => {
    alertsApi.update.mockRejectedValue(new Error('boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(addNotification).toHaveBeenCalledWith('error', expect.stringContaining('boom')));
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  });

  it('Probar usa dryRun y muestra la hoja', async () => {
    alertsApi.test.mockResolvedValue({ results: [{ asset: 'BTCUSDT', lowestTimeframe: '15m', score: 55, threshold: 70, wouldTrigger: false, rules: [] }] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Probar' }));
    const dialog = await screen.findByRole('dialog');
    expect(alertsApi.test).toHaveBeenCalledWith(1, { dryRun: true });
    expect(within(dialog).getByText(/55\.0% \/ 70%/)).toBeTruthy();
  });
});
