import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExitSimulator from './ExitSimulator';
import { TRUNCATED_TEXT } from './exitSimulator';
import { autoBotsApi } from '../autoTradingApi';

vi.mock('../autoTradingApi', () => ({ autoBotsApi: { exitSimulation: vi.fn() } }));

const sc = (tpPct, maxHoldHours, stopPct, pnlUsdt) => ({ tpPct, maxHoldHours, stopPct, pnlUsdt, trades: 5, wins: 3, avgHoldMinutes: 120, incomplete: 0, actualPnlUsdt: 2, actualWins: 2 });
// `trades` = operaciones con datos; el total real incluye 7 sin datos.
const data = (trades = 25) => ({
  mode: 'shadow', since: null,
  coverage: { positions: trades + 7, minute: 10, hourly: 8, none: 7, incomplete: 0 },
  actual: { pnlUsdt: -4.5, trades: trades + 7, wins: 9 },
  actualCovered: { pnlUsdt: 3.25, trades, wins: 8 },
  scenarios: [sc(60, 4, null, 10), sc(80, 4, null, -6), sc(60, 6, null, 3), sc(80, 6, null, 8), sc(60, 4, 50, 77), sc(80, 4, 50, 1), sc(60, 6, 50, 1), sc(80, 6, 50, 1)],
  best: [sc(60, 4, 50, 77), sc(60, 4, null, 10)],
});
const bot = (params = {}) => ({ id: 7, mode: 'shadow', params: { takeProfitMode: 'fixed', takeProfitPct: 80, maxHoldMinutes: 360, ...params } });
const open = () => fireEvent.click(screen.getByRole('button', { name: /Simulador de salidas/ }));

beforeEach(() => { vi.clearAllMocks(); });

describe('ExitSimulator', () => {
  it('no pide nada hasta abrirlo y luego usa modo y since', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    render(<ExitSimulator bot={bot()} since={1000} />);
    expect(autoBotsApi.exitSimulation).not.toHaveBeenCalled();
    open();
    await screen.findByText('Real con datos: 3,25 USDT · 25 operaciones');
    expect(screen.getByText(/Real total: −4,50 USDT \(32\)/)).toBeTruthy();
    expect(autoBotsApi.exitSimulation).toHaveBeenCalledWith(7, { mode: 'shadow', since: 1000 });
    expect(screen.getByText('32 operaciones · 10 con datos por minuto · 8 solo horarios · 7 sin datos')).toBeTruthy();
    expect(screen.queryByText(/Muestra pequeña/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Mejores combinaciones' });
    expect(within(table).getByText('+77,00 USDT')).toBeTruthy();
    expect(within(table).getAllByText('3/5')).toHaveLength(2);
    // 77 − 2 real de esas mismas posiciones.
    expect(within(table).getByText('+75,00 USDT')).toBeTruthy();
    expect(within(table).getByText('+8,00 USDT')).toBeTruthy();
  });

  it('la muestra pequeña cuenta las operaciones con datos, no el total', async () => {
    // El total real son 25 (≥ 20) pero solo 15 tienen datos: hay aviso.
    autoBotsApi.exitSimulation.mockResolvedValue({ ...data(25), actual: { pnlUsdt: 0, trades: 25, wins: 0 }, actualCovered: { pnlUsdt: 0, trades: 15, wins: 0 } });
    const { unmount } = render(<ExitSimulator bot={bot()} />);
    open();
    expect(await screen.findByText(/Muestra pequeña/)).toBeTruthy();
    unmount();
  });

  it('avisa de muestra pequeña con menos de 20 operaciones', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data(12));
    render(<ExitSimulator bot={bot()} />);
    open();
    expect(await screen.findByText('Muestra pequeña: úsalo para descartar ideas, no para afinar números.')).toBeTruthy();
  });

  it('el selector de stop cambia el mapa y marca la celda actual', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    render(<ExitSimulator bot={bot()} mobile />);
    open();
    await screen.findByRole('region', { name: /Mapa/ });
    const map = () => screen.getByRole('region', { name: /Mapa/ });
    expect(within(map()).getByText('−6')).toBeTruthy();
    expect(map().querySelector('[data-current="true"]').textContent).toBe('+8');
    fireEvent.click(screen.getByRole('button', { name: '50 %' }));
    expect(within(map()).getByText('+77')).toBeTruthy();
    expect(within(map()).queryByText('−6')).toBeNull();
  });

  it('tocar una celda muestra su detalle con vs real', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    render(<ExitSimulator bot={bot()} mobile />);
    open();
    const map = await screen.findByRole('region', { name: /Mapa/ });
    expect(screen.getByText('Toca una celda para ver su detalle.')).toBeTruthy();
    fireEvent.click(within(map).getByRole('button', { name: /TP \+80 % · tiempo 4 h/ }));
    expect(screen.getByText('TP +80 % · tiempo 4 h: −6,00 USDT · acierto 3/5 · vs real −8,00 USDT')).toBeTruthy();
  });

  it('con banda ATR no marca celda', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    render(<ExitSimulator bot={bot({ takeProfitMode: 'atr_band' })} />);
    open();
    await screen.findByRole('region', { name: /Mapa/ });
    expect(document.querySelector('[data-current="true"]')).toBeNull();
  });

  it('con truncated avisa de que solo usa las últimas 1000 operaciones', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue({ ...data(), truncated: true });
    const { unmount } = render(<ExitSimulator bot={bot()} mobile />);
    open();
    expect(await screen.findByText(TRUNCATED_TEXT)).toBeTruthy();
    expect(TRUNCATED_TEXT).toBe('Solo las últimas 1000 operaciones');
    unmount();
    autoBotsApi.exitSimulation.mockResolvedValue({ ...data(), truncated: false });
    render(<ExitSimulator bot={bot()} />);
    open();
    await screen.findByText(/Real con datos/);
    expect(screen.queryByText(TRUNCATED_TEXT)).toBeNull();
  });

  it('muestra carga y error con reintento', async () => {
    let reject;
    autoBotsApi.exitSimulation.mockReturnValueOnce(new Promise((_, rj) => { reject = rj; }));
    render(<ExitSimulator bot={bot()} />);
    open();
    expect(await screen.findByText('Calculando escenarios…')).toBeTruthy();
    reject(new Error('boom'));
    expect(await screen.findByText(/No se pudo calcular el simulador: boom/)).toBeTruthy();
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(screen.getByText(/Real con datos/)).toBeTruthy());
  });
});
