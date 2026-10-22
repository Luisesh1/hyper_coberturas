import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BacktestingTab, { BACKTEST_POLL_MS } from './BacktestingTab';
import { optionsBacktestsApi, optionsStrategiesApi } from '../optionsAutomationApi';
import { autoBotsApi } from '../autoTradingApi';

vi.mock('../optionsAutomationApi', () => ({
  optionsStrategiesApi: { listTemplates: vi.fn(), list: vi.fn(), get: vi.fn() },
  optionsBacktestsApi: { create: vi.fn(), list: vi.fn(), get: vi.fn() },
}));

vi.mock('../autoTradingApi', () => ({ autoBotsApi: { list: vi.fn() } }));

const BOTS = [{ id: 7, name: 'Bot ETH alcista', template: 'alert_signal', underlying: 'ETH', mode: 'shadow' }];
const STRATEGIES = [{ id: 1, name: 'Strangle semanal BTC', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' }];
const TEMPLATES = [{ id: 'short_strangle', label: 'Strangle corto', defaultParams: { deltaTarget: 0.2 }, paramSchema: [{ key: 'deltaTarget', label: 'Delta objetivo', type: 'number', min: 0.05, max: 0.5, step: 0.05 }] }];

const RESULT = {
  metrics: { returnPct: 38.2, maxDrawdownPct: -14.6, sharpe: 1.41, wins: 41, cycles: 52, premiumUsdt: 9840, worstCycleUsdt: -612 },
  equity: [
    { t: Date.parse('2025-10-01T00:00:00Z'), strategy: 5000, hodl: 5000 },
    { t: Date.parse('2026-04-01T00:00:00Z'), strategy: 5800, hodl: 4600 },
    { t: Date.parse('2026-10-01T00:00:00Z'), strategy: 6910, hodl: 5400 },
  ],
  cycles: [
    { openedAt: Date.parse('2026-09-26T08:15:00Z'), expiry: Date.parse('2026-10-03T08:00:00Z'), legs: [{ side: 'SELL', symbol: 'BTC-261003-70000-C' }, { side: 'SELL', symbol: 'BTC-261003-62000-P' }], premiumUsdt: 238.1, exitReason: 'Toma de ganancia', pnlUsdt: 119.05 },
    { openedAt: Date.parse('2026-09-12T08:15:00Z'), expiry: Date.parse('2026-09-19T08:00:00Z'), legs: [], premiumUsdt: 256, exitReason: 'Stop (Δ call 0,47)', pnlUsdt: -301.7 },
  ],
  sourceNote: 'Precios sintéticos con DVOL de Deribit.',
};

const originalMatchMedia = window.matchMedia;
function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  mockViewport(false);
  optionsStrategiesApi.list.mockResolvedValue(STRATEGIES);
  optionsStrategiesApi.listTemplates.mockResolvedValue(TEMPLATES);
  optionsBacktestsApi.list.mockResolvedValue([]);
  autoBotsApi.list.mockResolvedValue([]);
  optionsBacktestsApi.create.mockResolvedValue({ id: 99, status: 'queued' });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('BacktestingTab', () => {
  it('envía el backtest, sondea hasta «done» y pinta métricas, curva y ciclos', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    optionsBacktestsApi.get
      .mockResolvedValueOnce({ id: 99, status: 'running' })
      .mockResolvedValueOnce({ id: 99, status: 'done', config: { underlying: 'BTC', source: 'dvol', strategyId: 1, capitalUsdt: 5000 }, result: RESULT });

    render(<BacktestingTab />);
    const select = await screen.findByLabelText('Estrategia');
    await waitFor(() => expect(select.value).toBe('s:1'));

    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    await waitFor(() => expect(optionsBacktestsApi.create).toHaveBeenCalledTimes(1));
    expect(optionsBacktestsApi.create.mock.calls[0][0]).toMatchObject({
      strategyId: 1, underlying: 'BTC', capitalUsdt: 5000, source: 'dvol', spreadPct: 3, feePct: 0.03,
    });
    expect(await screen.findByText('Backtest en cola…')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ejecutando…/ }).disabled).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(BACKTEST_POLL_MS); });
    expect(await screen.findByText('Ejecutando backtest…')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(BACKTEST_POLL_MS); });
    expect(await screen.findByText('+38,2 %')).toBeTruthy();
    expect(screen.getByText('P&L neto')).toBeTruthy();
    expect(screen.getByText('+1.910,00 USDT')).toBeTruthy();
    expect(optionsBacktestsApi.get).toHaveBeenCalledWith(99);
    expect(screen.getByText('−14,6 %')).toBeTruthy();
    expect(screen.getByText('41 / 52')).toBeTruthy();
    expect(screen.getByText('Precios sintéticos con DVOL de Deribit.')).toBeTruthy();
    expect(screen.getByText('V 70000-C · V 62000-P')).toBeTruthy();
    expect(screen.getByText('Stop (Δ call 0,47)')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Curva de capital del backtest/ })).toBeTruthy();

    // Al terminar deja de sondear.
    const calls = optionsBacktestsApi.get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKTEST_POLL_MS * 3); });
    expect(optionsBacktestsApi.get.mock.calls.length).toBe(calls);
  });

  it('muestra el error de una ejecución fallida', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    optionsBacktestsApi.get.mockResolvedValueOnce({ id: 99, status: 'failed', error: 'Sin snapshots en el periodo' });
    render(<BacktestingTab />);
    await waitFor(() => expect(screen.getByLabelText('Estrategia').value).toBe('s:1'));
    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    await waitFor(() => expect(optionsBacktestsApi.create).toHaveBeenCalled());
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKTEST_POLL_MS); });
    expect(await screen.findByText(/El backtest falló: Sin snapshots en el periodo/)).toBeTruthy();
  });

  it('DVOL se desactiva con pista para subyacentes distintos de BTC/ETH y pasa a vol. realizada', async () => {
    render(<BacktestingTab />);
    await waitFor(() => expect(screen.getByLabelText('Estrategia').value).toBe('s:1'));
    const dvol = screen.getByRole('button', { name: /Índice DVOL \+ sonrisa/ });
    expect(dvol.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'SOL' }));
    expect(screen.getByRole('button', { name: /Índice DVOL \+ sonrisa/ }).disabled).toBe(true);
    expect(screen.getByText(/No disponible para SOL/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Volatilidad realizada/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Prima de volatilidad')).toBeTruthy();
  });

  it('con plantilla envía template + params', async () => {
    render(<BacktestingTab />);
    const select = await screen.findByLabelText('Estrategia');
    await waitFor(() => expect(select.value).toBe('s:1'));
    fireEvent.change(select, { target: { value: 't:short_strangle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Delta objetivo' }));
    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    await waitFor(() => expect(optionsBacktestsApi.create).toHaveBeenCalled());
    expect(optionsBacktestsApi.create.mock.calls[0][0]).toMatchObject({ template: 'short_strangle', params: { deltaTarget: 0.25 } });
  });

  it('abre el último backtest terminado del historial y exporta sus ciclos a CSV', async () => {
    optionsBacktestsApi.list.mockResolvedValue([
      { id: 5, status: 'done', config: { strategyId: 1, underlying: 'BTC', source: 'dvol', from: 1, to: 2 }, created_at: 2000 },
    ]);
    optionsBacktestsApi.get.mockResolvedValue({ id: 5, status: 'done', config: { strategyId: 1, underlying: 'BTC', source: 'dvol' }, result: RESULT });
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<BacktestingTab />);
    expect(await screen.findByText('+38,2 %')).toBeTruthy();
    expect(optionsBacktestsApi.get).toHaveBeenCalledWith(5);
    expect(screen.getByRole('button', { name: /Strangle semanal BTC/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('BacktestingTab · móvil', () => {
  it('tarjeta-resumen que abre la hoja de configuración y CTA fijo', async () => {
    mockViewport(true);
    render(<BacktestingTab />);
    const summary = await screen.findByRole('button', { name: /Configurar backtest: Strangle semanal BTC/ });
    expect(summary.textContent).toContain('DVOL');
    // El formulario no está en la página: vive en la hoja.
    expect(screen.queryByLabelText('Estrategia')).toBeNull();

    fireEvent.click(summary);
    const sheet = await screen.findByRole('dialog', { name: 'Configuración del backtest' });
    fireEvent.click(within(sheet).getByRole('button', { name: /Volatilidad realizada/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Listo' }));
    expect(screen.queryByRole('dialog', { name: 'Configuración del backtest' })).toBeNull();
    expect(screen.getByRole('button', { name: /Configurar backtest/ }).textContent).toContain('Vol. realizada');

    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    await waitFor(() => expect(optionsBacktestsApi.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'realized', volPremiumPct: 10 })));
  });

  it('si el formulario no es válido abre la hoja con los errores en vez de enviar', async () => {
    mockViewport(true);
    optionsStrategiesApi.list.mockResolvedValue([]);
    render(<BacktestingTab />);
    await screen.findByRole('button', { name: /Configurar backtest: Elige una estrategia/ });
    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Configuración del backtest' });
    expect(within(sheet).getByText('Elige una estrategia o una plantilla')).toBeTruthy();
    expect(optionsBacktestsApi.create).not.toHaveBeenCalled();
  });

  it('con el id de un bot preselecciona el bot y deshabilita «IV registrada» con su motivo', async () => {
    autoBotsApi.list.mockResolvedValue(BOTS);
    render(<BacktestingTab initialStrategyId="7" />);
    const select = await screen.findByLabelText('Estrategia');
    await waitFor(() => expect(select.value).toBe('s:7'));
    expect(within(select).getByText('Bot ETH alcista · ETH · bot')).toBeTruthy();
    const recorded = screen.getByRole('button', { name: /IV registrada por la app/ });
    expect(recorded.disabled).toBe(true);
    expect(screen.getByText(/Los bots solo admiten DVOL o volatilidad realizada/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Índice DVOL/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('muestra el error 400 del servidor y el resumen de señales', async () => {
    autoBotsApi.list.mockResolvedValue(BOTS);
    optionsBacktestsApi.create.mockRejectedValueOnce(new Error('Las alertas de este bot no se dispararon entre a y b'));
    render(<BacktestingTab initialStrategyId="7" />);
    await waitFor(() => expect((screen.getByLabelText('Estrategia')).value).toBe('s:7'));
    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    expect(await screen.findByText(/Las alertas de este bot no se dispararon/)).toBeTruthy();
  });

  it('muestra «Señales: N recibidas · M operadas» en el resultado de un bot', async () => {
    optionsBacktestsApi.list.mockResolvedValue([{ id: 5, status: 'done', config: { underlying: 'ETH', source: 'dvol', strategyId: 7, capitalUsdt: 5000 }, result: { ...RESULT, signals: { received: 12, traded: 9, ignored: 3 } } }]);
    render(<BacktestingTab />);
    expect(await screen.findByText(/Señales: 12 recibidas · 9 operadas/)).toBeTruthy();
  });

  it('con un bot multi-subyacente el selector solo ofrece los del bot y avisa', async () => {
    autoBotsApi.list.mockResolvedValue([{ ...BOTS[0], underlying: 'BTC', params: { underlyings: ['BTC', 'ETH'] } }]);
    render(<BacktestingTab initialStrategyId="7" />);
    await waitFor(() => expect((screen.getByLabelText('Estrategia')).value).toBe('s:7'));
    const group = screen.getByRole('radiogroup', { name: 'Subyacente' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['BTC', 'ETH']);
    expect(screen.getByText('Se prueba un subyacente a la vez; los límites se aplican solo a él')).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'ETH' }));
    fireEvent.click(screen.getByRole('button', { name: /Ejecutar backtest/ }));
    await waitFor(() => expect(optionsBacktestsApi.create).toHaveBeenCalled());
    expect(optionsBacktestsApi.create.mock.calls[0][0]).toMatchObject({ strategyId: 7, underlying: 'ETH' });
  });
});
