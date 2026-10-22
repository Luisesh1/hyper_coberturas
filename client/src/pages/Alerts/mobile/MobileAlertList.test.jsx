import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MobileAlertList from './MobileAlertList';

const RULES = [{
  weight: 1,
  conditions: [{ indicatorType: 'rsi', indicatorParams: {}, timeframe: '15m', operandSeries: 'line', operator: '<', operand: { kind: 'constant', value: 30 } }],
  joiners: [],
}];

const alertOf = (id, name, direction, extra = {}) => ({
  id, name, direction, isActive: true, thresholdPercent: 70, cooldownSeconds: 900,
  telegramEnabled: true, datasource: 'binance', assetList: ['BTCUSDT', 'ETHUSDT'], rules: RULES, ...extra,
});

const ALERTS = [
  alertOf(1, 'RSI sobrevendido', 'bullish', { lastTriggeredAt: { BTCUSDT: new Date(2020, 0, 5, 8, 7).getTime() } }),
  alertOf(2, 'RSI sobrecomprado', 'bearish', { isActive: false }),
  alertOf(3, 'Volumen anómalo', 'neutral'),
];

const TEST_DATA = {
  results: [{
    asset: 'BTCUSDT', lowestTimeframe: '15m', score: 80, threshold: 70, wouldTrigger: true,
    rules: [{ matched: true, reason: 'RSI < 30' }],
  }],
};

function setup(overrides = {}) {
  const props = {
    alerts: ALERTS,
    botUsage: new Map([[1, [{ id: 9, name: 'Bot' }]]]),
    directionFilter: 'all',
    onDirectionFilter: vi.fn(),
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onToggleActive: vi.fn().mockResolvedValue(undefined),
    onTest: vi.fn().mockResolvedValue(TEST_DATA),
    ...overrides,
  };
  render(<MobileAlertList {...props} />);
  return props;
}

const card = (name) => screen.getByText(name).closest('article');

describe('MobileAlertList', () => {
  it('cabecera con totales', () => {
    setup();
    expect(screen.getByText('3 en total · 2 activas')).toBeTruthy();
  });

  it('la tarjeta muestra nombre, meta, chips y Último disparo', () => {
    setup();
    const c = within(card('RSI sobrevendido'));
    expect(c.getByText(/2 activos · 1 reglas? · umbral 70 ?%/)).toBeTruthy();
    expect(c.getByTestId('direction-chip').textContent).toContain('Alcista');
    expect(c.getByText('15m')).toBeTruthy();
    expect(c.getByText('Usada por 1 bot')).toBeTruthy();
    expect(c.getByText(/Último disparo: 05\/01 08:07/)).toBeTruthy();
    expect(within(card('Volumen anómalo')).getByText('Sin bots')).toBeTruthy();
    expect(within(card('Volumen anómalo')).getByText(/Último disparo: Nunca/)).toBeTruthy();
    expect(within(card('RSI sobrecomprado')).getByText(/Último disparo: Pausada/)).toBeTruthy();
  });

  it('sin botUsage no muestra chip de bots', () => {
    setup({ botUsage: null });
    expect(screen.queryByText('Sin bots')).toBeNull();
  });

  it('los filtros muestran contadores', () => {
    const p = setup();
    expect(screen.getByRole('button', { name: /Todas\s*3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Alcistas\s*1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Bajistas\s*1/ }));
    expect(p.onDirectionFilter).toHaveBeenCalledWith('bearish');
  });

  it('aplica el filtro de dirección', () => {
    setup({ directionFilter: 'bearish' });
    expect(screen.queryByText('RSI sobrevendido')).toBeNull();
    expect(screen.getByText('RSI sobrecomprado')).toBeTruthy();
  });

  it('el interruptor llama a onToggleActive y se refleja al instante', async () => {
    const p = setup();
    const sw = within(card('RSI sobrevendido')).getByRole('switch', { name: 'RSI sobrevendido: Activa' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(p.onToggleActive).toHaveBeenCalledWith(ALERTS[0]);
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  it('si onToggleActive se rechaza, el interruptor vuelve a su estado', async () => {
    let reject;
    const onToggleActive = vi.fn().mockReturnValue(new Promise((_, r) => { reject = r; }));
    setup({ onToggleActive });
    const sw = within(card('RSI sobrevendido')).getByRole('switch');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // El nombre accesible incluye el texto visible (WCAG 2.5.3).
    expect(sw.getAttribute('aria-label')).toBe('RSI sobrevendido: Pausada');
    reject(new Error('x'));
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(sw.getAttribute('aria-label')).toBe('RSI sobrevendido: Activa');
  });

  it('Probar abre la hoja con la puntuación', async () => {
    const p = setup();
    fireEvent.click(within(card('RSI sobrevendido')).getByRole('button', { name: 'Probar' }));
    expect(p.onTest).toHaveBeenCalledWith(ALERTS[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/80\.0% \/ 70%/)).toBeTruthy();
    expect(within(dialog).getByText(/RSI < 30/)).toBeTruthy();
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  it('tocar la tarjeta llama a onOpen', () => {
    const p = setup();
    fireEvent.click(screen.getByText('Volumen anómalo'));
    expect(p.onOpen).toHaveBeenCalledWith(ALERTS[2]);
  });

  it('el botón flotante llama a onNew', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Nueva alerta' }));
    expect(p.onNew).toHaveBeenCalled();
  });

  it('estado vacío', () => {
    setup({ alerts: [] });
    expect(screen.getByText(/Aún no tienes alertas/)).toBeTruthy();
  });
});
