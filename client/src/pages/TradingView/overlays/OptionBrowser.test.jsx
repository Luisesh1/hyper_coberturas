import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  marketApi: { getOptionExpiries: vi.fn(), getOptionStrikes: vi.fn() },
}));

import { marketApi } from '../../../services/api';
import OptionBrowser, { expiryLabel, initialUnderlying, relativeDays } from './OptionBrowser';

const NOW = Date.UTC(2026, 9, 21, 12);
// Deribit vence los viernes a las 08:00 UTC: 23 y 9 oct 2026.
const OCT23 = Date.UTC(2026, 9, 23, 8);
const OCT09 = Date.UTC(2026, 9, 9, 8);
const EXPIRIES = [
  { code: '23OCT26', expiryMs: OCT23, live: true },
  { code: '9OCT26', expiryMs: OCT09, live: false },
];
const row = (strike, distancePct, { call = true, put = true } = {}) => ({
  strike,
  distancePct,
  call: call ? `ETH-9OCT26-${strike}-C` : null,
  put: put ? `ETH-9OCT26-${strike}-P` : null,
});

function renderBrowser(props = {}) {
  const onAdd = vi.fn();
  render(<OptionBrowser mainUnderlying="ETH" addedIds={new Set()} onAdd={onAdd} {...props} />);
  return { onAdd };
}

async function openExpiry(label = /9 oct 2026/) {
  fireEvent.click(await screen.findByRole('button', { name: label }));
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  marketApi.getOptionExpiries.mockResolvedValue(EXPIRIES);
});

afterEach(() => {
  vi.restoreAllMocks();
  marketApi.getOptionExpiries.mockReset();
  marketApi.getOptionStrikes.mockReset();
});

describe('helpers', () => {
  it('etiqueta de vencimiento en es-ES (UTC) y días relativos', () => {
    expect(expiryLabel(OCT09)).toBe('vie 9 oct 2026');
    expect(relativeDays(OCT23, NOW)).toBe('en 2 d');
    expect(relativeDays(OCT09, NOW)).toBe('hace 12 d');
  });

  it('preselección del subyacente', () => {
    expect(initialUnderlying('BTC')).toEqual({ underlying: 'BTC', unsupported: false });
    expect(initialUnderlying('BNB')).toEqual({ underlying: null, unsupported: true });
    expect(initialUnderlying('DOGE')).toEqual({ underlying: null, unsupported: true });
    expect(initialUnderlying('SPX')).toEqual({ underlying: 'ETH', unsupported: false });
  });
});

describe('OptionBrowser (escritorio)', () => {
  it('preselecciona el subyacente del principal y agrupa los vencimientos', async () => {
    renderBrowser({ mainUnderlying: 'SOL' });
    expect(screen.getByRole('button', { name: 'SOL' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(marketApi.getOptionExpiries).toHaveBeenCalledWith('SOL'));
    expect(await screen.findByText('Vigentes')).toBeTruthy();
    expect(screen.getByText('Vencidos · último año')).toBeTruthy();
    expect(screen.getByText('en 2 d')).toBeTruthy();
    expect(screen.getByText('hace 12 d')).toBeTruthy();
  });

  it('BNB: muestra la nota y no preselecciona nada', () => {
    renderBrowser({ mainUnderlying: 'BNB' });
    expect(screen.getByText('BNB y DOGE no cotizan en Deribit')).toBeTruthy();
    expect(marketApi.getOptionExpiries).not.toHaveBeenCalled();
  });

  it('el buscador filtra vencimientos por fecha', async () => {
    renderBrowser();
    await screen.findByText('Vigentes');
    fireEvent.change(screen.getByPlaceholderText('Fecha de vencimiento'), { target: { value: '23 oct' } });
    expect(screen.queryByRole('button', { name: /9 oct 2026/ })).toBeNull();
    expect(screen.getByRole('button', { name: /23 oct 2026/ })).toBeTruthy();
  });

  it('sondea strikes cada 800 ms mientras corre: progreso y luego la tabla', async () => {
    marketApi.getOptionStrikes
      .mockResolvedValueOnce({ status: 'running', probed: 3, total: 10, spotRef: 2418, strikes: [row(2400, -0.7)], error: null })
      .mockResolvedValueOnce({
        status: 'done', probed: 10, total: 10, spotRef: 2418,
        strikes: [row(2500, 3.4), row(2400, -0.7), row(2700, 11.7, { call: false, put: false })], error: null,
      });
    renderBrowser();
    await openExpiry();
    expect(await screen.findByText('Buscando strikes · 3 de 10')).toBeTruthy();
    expect(marketApi.getOptionStrikes).toHaveBeenCalledWith('ETH', '9OCT26', { retry: false });
    await waitFor(() => expect(screen.getByText('2,500')).toBeTruthy(), { timeout: 2500 });
    expect(screen.queryByText(/Buscando strikes/)).toBeNull();
    expect(marketApi.getOptionStrikes).toHaveBeenCalledTimes(2);
    // ATM = menor |distancia|
    const atmRow = screen.getByText('ATM').closest('[role="row"]');
    expect(within(atmRow).getByText(/2,400/)).toBeTruthy();
    // filas ordenadas por strike
    const strikes = screen.getAllByRole('row').slice(1).map((r) => r.getAttribute('data-strike'));
    expect(strikes).toEqual(['2400', '2500', '2700']);
    expect(screen.getAllByText('Sin operaciones')).toHaveLength(2);
    expect(screen.getByText('ETH a 7 días del vencimiento:')).toBeTruthy();
  });

  it('deja de sondear al desmontar', async () => {
    marketApi.getOptionStrikes.mockResolvedValue({ status: 'running', probed: 1, total: 10, spotRef: 2418, strikes: [], error: null });
    const { unmount } = render(<OptionBrowser mainUnderlying="ETH" addedIds={new Set()} onAdd={vi.fn()} />);
    await openExpiry();
    await screen.findByText('Buscando strikes · 1 de 10');
    unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    expect(marketApi.getOptionStrikes).toHaveBeenCalledTimes(1);
  });

  it('fallo de Deribit: tabla parcial y "Reintentar" relanza con retry', async () => {
    marketApi.getOptionStrikes
      .mockResolvedValueOnce({ status: 'error', probed: 6, total: 10, spotRef: 2418, strikes: [row(2400, -0.7)], error: 'rate limit' })
      .mockResolvedValueOnce({ status: 'done', probed: 10, total: 10, spotRef: 2418, strikes: [row(2400, -0.7), row(2450, 1.3)], error: null });
    renderBrowser();
    await openExpiry();
    expect(await screen.findByText('No se pudieron revisar todos los strikes')).toBeTruthy();
    expect(screen.getByText(/2,400/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(marketApi.getOptionStrikes).toHaveBeenLastCalledWith('ETH', '9OCT26', { retry: true }));
    expect(await screen.findByText('2,450')).toBeTruthy();
  });

  it('añadir una CALL llama a onAdd con la especificación de opción', async () => {
    marketApi.getOptionStrikes.mockResolvedValue({ status: 'done', probed: 2, total: 2, spotRef: 2418, strikes: [row(2400, -0.7)], error: null });
    const { onAdd } = renderBrowser();
    await openExpiry();
    fireEvent.click(await screen.findByRole('button', { name: 'Añadir CALL 2400' }));
    expect(onAdd).toHaveBeenCalledWith({
      kind: 'option',
      option: { instrument: 'ETH-9OCT26-2400-C', underlying: 'ETH', expiryMs: OCT09, strike: 2400, type: 'C' },
    });
  });

  it('marca "Añadida" lo que ya está y desactiva al llegar al tope', async () => {
    marketApi.getOptionStrikes.mockResolvedValue({ status: 'done', probed: 2, total: 2, spotRef: 2418, strikes: [row(2400, -0.7)], error: null });
    renderBrowser({ addedIds: new Set(['option:ETH-9OCT26-2400-C']), full: true });
    await openExpiry();
    expect(await screen.findByText('Añadida')).toBeTruthy();
    const put = screen.getByRole('button', { name: 'Añadir PUT 2400' });
    expect(put.disabled).toBe(true);
    expect(put.getAttribute('title')).toBe('Máximo 6 superposiciones');
  });
});

describe('OptionBrowser (móvil)', () => {
  it('tres pasos con botón atrás que vuelve al vencimiento', async () => {
    marketApi.getOptionStrikes.mockResolvedValue({ status: 'done', probed: 2, total: 2, spotRef: 2418, strikes: [row(2400, -0.7)], error: null });
    const { onAdd } = renderBrowser({ mobile: true });
    expect(screen.getByText('Paso 1 de 3 · Subyacente')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ETH' }));
    expect(screen.getByText('Paso 2 de 3 · Vencimiento')).toBeTruthy();
    await openExpiry();
    expect(screen.getByText('Paso 3 de 3 · Strike')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Añadir CALL 2400' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(screen.getByText('Paso 2 de 3 · Vencimiento')).toBeTruthy();
    expect(screen.getByRole('button', { name: /9 oct 2026/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(screen.getByText('Paso 1 de 3 · Subyacente')).toBeTruthy();
  });
});
