import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import BotForm from './BotForm';
import { ATR_BAND_SWITCH_WARNING } from './botView';
import { autoBotsApi } from '../autoTradingApi';

vi.mock('../autoTradingApi', () => ({
  autoBotsApi: { eligibleAlerts: vi.fn(() => Promise.resolve([])) },
}));

const OPEN = { id: 5, mode: 'shadow', symbol: 'ETH-261031-2500-C', side: 'BUY', closedAt: null };
const bot = (mode, positions) => ({
  id: 1, name: 'Bot', underlying: 'ETH', alertIds: [], alerts: [], limits: {},
  params: { structure: 'buy_with', takeProfitMode: mode },
  positions,
});

function renderEdit(b) {
  render(<MemoryRouter><BotForm open bot={b} underlying="ETH" onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
}

describe('BotForm · aviso al pasar a Banda ATR', () => {
  it('editando un bot fijo con posiciones abiertas, al elegir Banda ATR muestra el aviso', () => {
    renderEdit(bot('fixed', [OPEN]));
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Banda ATR' }));
    expect(screen.getByText(ATR_BAND_SWITCH_WARNING)).toBeTruthy();
  });

  it('sin posiciones abiertas no lo muestra', () => {
    renderEdit(bot('fixed', [{ ...OPEN, closedAt: 123 }]));
    fireEvent.click(screen.getByRole('radio', { name: 'Banda ATR' }));
    expect(screen.getByText('Longitud del ATR')).toBeTruthy();
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
  });

  it('si el modo guardado ya es Banda ATR no lo muestra', () => {
    renderEdit(bot('atr_band', [OPEN]));
    expect(screen.getByText('Longitud del ATR')).toBeTruthy();
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
  });
});

describe('BotForm · presupuesto total', () => {
  it('con presupuesto muestra «Hasta X USDT por señal» y oculta el capital por entrada', () => {
    renderEdit({ ...bot('fixed', []), params: { structure: 'buy_with', takeProfitMode: 'fixed', capitalUsdt: 500 } });
    expect(screen.getAllByLabelText(/Capital asignado/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('textbox', { name: /Presupuesto total/ }), { target: { value: '48' } });
    expect(screen.getByText('Hasta 12 USDT por señal')).toBeTruthy();
    expect(screen.queryAllByLabelText(/Capital asignado/)).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: /Fracciones/ }), { target: { value: '6' } });
    expect(screen.getByText('Hasta 8 USDT por señal')).toBeTruthy();
  });
});

describe('BotForm · varios subyacentes', () => {
  const ALERT = { id: 3, name: 'Cruce alcista', direction: 'bullish', assetList: ['BTCUSDT', 'ETHUSDT'], coveredUnderlyings: ['BTC', 'ETH'] };

  it('elige BTC y ETH: pide alertas de ambos, muestra qué cubre cada una y envía underlyings', async () => {
    autoBotsApi.eligibleAlerts.mockResolvedValue([ALERT]);
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<MemoryRouter><BotForm open underlying="BTC" onCancel={() => {}} onSubmit={onSubmit} /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: /Nombre/ }), { target: { value: 'Multi' } });
    expect(screen.getByRole('button', { name: 'BTC' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'ETH' }));
    await waitFor(() => expect(autoBotsApi.eligibleAlerts).toHaveBeenLastCalledWith('BTC,ETH'));
    const row = await screen.findByRole('checkbox', { name: /Cruce alcista/ });
    expect(row.textContent).toContain('BTC, ETH');
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Crear bot' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ underlying: 'BTC', underlyings: ['BTC', 'ETH'], alertIds: [3] });
  });

  it('un subyacente sin alerta marcada que lo cubra da error y no envía', async () => {
    autoBotsApi.eligibleAlerts.mockResolvedValue([{ ...ALERT, coveredUnderlyings: ['BTC'], assetList: ['BTCUSDT'] }]);
    const onSubmit = vi.fn();
    render(<MemoryRouter><BotForm open underlying="BTC" onCancel={() => {}} onSubmit={onSubmit} /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: /Nombre/ }), { target: { value: 'Multi' } });
    fireEvent.click(screen.getByRole('button', { name: 'ETH' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Cruce alcista/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear bot' }));
    expect(await screen.findByText('Ninguna alerta marcada cubre ETH')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('no permite quitar el último subyacente', () => {
    autoBotsApi.eligibleAlerts.mockResolvedValue([]);
    render(<MemoryRouter><BotForm open underlying="BTC" onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'BTC' }));
    expect(screen.getByRole('button', { name: 'BTC' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('editando un bot antiguo marca su único subyacente', () => {
    renderEdit(bot('fixed', []));
    expect(screen.getByRole('button', { name: 'ETH' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'BTC' }).getAttribute('aria-pressed')).toBe('false');
  });
});
