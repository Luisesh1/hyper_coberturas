import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExitSimulator from './ExitSimulator';
import { autoBotsApi } from '../autoTradingApi';

vi.mock('../autoTradingApi', () => ({ autoBotsApi: { exitSimulation: vi.fn() } }));

const sc = (tpPct, maxHoldHours, stopPct, pnlUsdt) => ({ tpPct, maxHoldHours, stopPct, pnlUsdt, trades: 5, wins: 3, avgHoldMinutes: 120, incomplete: 0 });
const data = (trades = 25) => ({
  mode: 'shadow', since: null,
  coverage: { positions: trades, minute: 10, hourly: 8, none: 7, incomplete: 0 },
  actual: { pnlUsdt: -4.5, trades, wins: 9 },
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
    await screen.findByText(/Real: −4,50 USDT/);
    expect(autoBotsApi.exitSimulation).toHaveBeenCalledWith(7, { mode: 'shadow', since: 1000 });
    expect(screen.getByText('25 operaciones · 10 con datos por minuto · 8 solo horarios · 7 sin datos')).toBeTruthy();
    expect(screen.queryByText(/Muestra pequeña/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Mejores combinaciones' });
    expect(within(table).getByText('+77,00 USDT')).toBeTruthy();
    expect(within(table).getAllByText('3/5')).toHaveLength(2).toBeTruthy();
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

  it('con banda ATR no marca celda', async () => {
    autoBotsApi.exitSimulation.mockResolvedValue(data());
    render(<ExitSimulator bot={bot({ takeProfitMode: 'atr_band' })} />);
    open();
    await screen.findByRole('region', { name: /Mapa/ });
    expect(document.querySelector('[data-current="true"]')).toBeNull();
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
    await waitFor(() => expect(screen.getByText(/Real:/)).toBeTruthy());
  });
});
