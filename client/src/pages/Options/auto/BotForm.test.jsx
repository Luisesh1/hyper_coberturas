import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function renderEdit(b, props = {}) {
  render(<MemoryRouter><BotForm open bot={b} underlying="ETH" onCancel={() => {}} onSubmit={() => {}} {...props} /></MemoryRouter>);
}

const toMode = (name) => fireEvent.click(screen.getByRole('radio', { name }));

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* sin almacenamiento */ }
});

describe('BotForm · modos Simple, Avanzado y Presets', () => {
  it('abre en Simple: lo esencial a la vista y los campos finos ocultos', () => {
    renderEdit(bot('fixed', []));
    for (const name of ['Simple', 'Avanzado', 'Presets']) expect(screen.getByRole('radio', { name })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Simple' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('textbox', { name: /Riesgo por operación/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Spread máx/ })).toBeNull();
    toMode('Avanzado');
    expect(screen.getByRole('textbox', { name: /Spread máx/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Riesgo por operación/ })).toBeNull();
  });

  it('Presets aplica strike, vencimiento y salida; Simple los muestra y al tocar uno pasa a Personalizado', () => {
    renderEdit(bot('fixed', []));
    toMode('Presets');
    fireEvent.click(screen.getByRole('radio', { name: /Swing/ }));
    expect(screen.getByRole('radio', { name: /Swing/ }).getAttribute('aria-checked')).toBe('true');
    toMode('Simple');
    expect(screen.getByRole('radio', { name: 'Equilibrado' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '~1 semana' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Preset: Swing')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Cercano' }));
    expect(screen.getByText('Preset: Personalizado')).toBeTruthy();
  });

  it('Riesgo por operación envía capitalUsdt y sube la cantidad máxima al tope', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderEdit({ ...bot('fixed', []), alertIds: [7], alerts: [{ id: 7, name: 'A', direction: 'bullish', assetList: ['ETHUSDT'], coveredUnderlyings: ['ETH'] }] }, { onSubmit });
    fireEvent.change(screen.getByRole('textbox', { name: /Riesgo por operación/ }), { target: { value: '10' } });
    expect(screen.getByText(/arriesgando hasta 10 USDT/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].params).toMatchObject({ capitalUsdt: 10, quantity: 1 });
  });

  it('tiempo máximo en los tres modos: Simple, Presets y Avanzado envían maxHoldMinutes', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderEdit({ ...bot('fixed', []), alertIds: [7], alerts: [{ id: 7, name: 'A', direction: 'bullish', assetList: ['ETHUSDT'], coveredUnderlyings: ['ETH'] }] }, { onSubmit });
    expect(screen.getByRole('radio', { name: 'Sin límite' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '1 día' }));
    expect(screen.getByText(/Cierra como máximo tras 1 día en posición/)).toBeTruthy();
    toMode('Presets');
    expect(screen.getByText('Máx. 4 h en posición')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Rápido/ }));
    toMode('Avanzado');
    expect(screen.getByRole('radio', { name: '4 h' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: /Tiempo máximo en posición/ }), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('radio', { name: 'min' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Tiempo máximo en posición/ }), { target: { value: '90' } });
    toMode('Simple');
    expect(screen.getByText('Personalizado: 1 h 30 min. Ajústalo en Avanzado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].params.maxHoldMinutes).toBe(90);
  });

  it('pérdida diaria máx.: Simple no la muestra y conserva la del bot', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const withAlert = { ...bot('fixed', []), limits: { maxDailyLossUsdt: 40, maxOrdersPerDay: 10 }, alertIds: [7], alerts: [{ id: 7, name: 'A', direction: 'bullish', assetList: ['ETHUSDT'], coveredUnderlyings: ['ETH'] }] };
    renderEdit(withAlert, { onSubmit });
    expect(screen.queryByRole('textbox', { name: /Pérdida diaria máx/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].limits).toEqual({ maxDailyLossUsdt: 40, maxOrdersPerDay: 10 });
  });

  it('pérdida diaria máx. en Avanzado: valida > 0 y envía el valor editado', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const withAlert = { ...bot('fixed', []), limits: { maxDailyLossUsdt: 40, maxOrdersPerDay: 10 }, alertIds: [7], alerts: [{ id: 7, name: 'A', direction: 'bullish', assetList: ['ETHUSDT'], coveredUnderlyings: ['ETH'] }] };
    renderEdit(withAlert, { onSubmit });
    toMode('Avanzado');
    const field = screen.getByRole('textbox', { name: /Pérdida diaria máx/ });
    expect(field.value).toBe('40');
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Debe ser mayor a 0')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: /Pérdida diaria máx/ }), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].limits).toEqual({ maxDailyLossUsdt: 300, maxOrdersPerDay: 10 });
  });

  it('un bot nuevo nace con el preset Rápido', () => {
    render(<MemoryRouter><BotForm open underlying="BTC" onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
    expect(screen.getByText('Preset: Rápido')).toBeTruthy();
    expect(screen.getAllByText('Más cercana al precio · venc. ~2 d').length).toBe(2);
  });

  it('recuerda el último modo al volver a abrir', () => {
    const { unmount } = render(<MemoryRouter><BotForm open bot={bot('fixed', [])} underlying="ETH" onCancel={() => {}} onSubmit={() => {}} /></MemoryRouter>);
    toMode('Avanzado');
    unmount();
    renderEdit(bot('fixed', []));
    expect(screen.getByRole('radio', { name: 'Avanzado' }).getAttribute('aria-checked')).toBe('true');
  });

  it('pulsar fuera del editor no lo cierra', () => {
    const onCancel = vi.fn();
    renderEdit(bot('fixed', []), { onCancel });
    fireEvent.click(document.querySelector('[class*="scrim"]'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('BotForm · aviso al pasar a Banda ATR', () => {
  it('editando un bot fijo con posiciones abiertas, al elegir Banda ATR muestra el aviso', () => {
    renderEdit(bot('fixed', [OPEN]));
    toMode('Avanzado');
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Banda ATR' }));
    expect(screen.getByText(ATR_BAND_SWITCH_WARNING)).toBeTruthy();
  });

  it('sin posiciones abiertas no lo muestra', () => {
    renderEdit(bot('fixed', [{ ...OPEN, closedAt: 123 }]));
    toMode('Avanzado');
    fireEvent.click(screen.getByRole('radio', { name: 'Banda ATR' }));
    expect(screen.getByText('Longitud del ATR')).toBeTruthy();
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
  });

  it('si el modo guardado ya es Banda ATR no lo muestra', () => {
    renderEdit(bot('atr_band', [OPEN]));
    toMode('Avanzado');
    expect(screen.getByText('Longitud del ATR')).toBeTruthy();
    expect(screen.queryByText(ATR_BAND_SWITCH_WARNING)).toBeNull();
  });
});

describe('BotForm · señal contraria con Banda ATR', () => {
  it('muestra Girar / Solo cerrar / Ignorar también en Banda ATR', () => {
    renderEdit(bot('atr_band', []));
    expect(screen.getByText('Si llega la señal contraria')).toBeTruthy();
    for (const name of ['Girar', 'Solo cerrar', 'Ignorar']) expect(screen.getByRole('radio', { name })).toBeTruthy();
  });
});

describe('BotForm · presupuesto total', () => {
  it('con presupuesto muestra «Hasta X USDT por señal» y oculta el capital por entrada', () => {
    renderEdit({ ...bot('fixed', []), params: { structure: 'buy_with', takeProfitMode: 'fixed', capitalUsdt: 500 } });
    toMode('Avanzado');
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
