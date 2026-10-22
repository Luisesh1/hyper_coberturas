import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import BotForm from './BotForm';
import { ATR_BAND_SWITCH_WARNING } from './botView';

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
