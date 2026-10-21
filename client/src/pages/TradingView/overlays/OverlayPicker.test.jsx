import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  marketApi: { getCatalog: vi.fn(), getOptionExpiries: vi.fn(), getOptionStrikes: vi.fn() },
}));

import { marketApi } from '../../../services/api';
import OverlayPicker, { mainUnderlyingOf } from './OverlayPicker';

const CATALOG = {
  categories: { crypto: 'Cripto (spot)', commodities: 'Commodities' },
  assets: [
    { id: 'binance:ETHUSDT', symbol: 'ETHUSDT', name: 'Ethereum', datasource: 'binance', category: 'crypto' },
    { id: 'binance:BTCUSDT', symbol: 'BTCUSDT', name: 'Bitcoin', datasource: 'binance', category: 'crypto' },
    { id: 'binance:XRPUSDT', symbol: 'XRPUSDT', name: 'XRP', datasource: 'binance', category: 'crypto' },
    { id: 'yahoo:GC=F', symbol: 'GC=F', name: 'Oro (XAU)', datasource: 'yahoo', category: 'commodities' },
  ],
};
const btc = { id: 'asset:binance:BTCUSDT', kind: 'asset', color: '#22d3ee', hidden: false, asset: { symbol: 'BTCUSDT', datasource: 'binance', name: 'Bitcoin' } };
const opt = {
  id: 'option:ETH-31OCT26-2500-C', kind: 'option', color: '#a78bfa', hidden: false,
  option: { instrument: 'ETH-31OCT26-2500-C', underlying: 'ETH', expiryMs: Date.UTC(2026, 9, 31, 8), strike: 2500, type: 'C' },
};
const mainAsset = { symbol: 'ethusdt', datasource: 'binance', name: 'Ethereum' };

function renderPicker(props = {}) {
  const handlers = { onAdd: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() };
  render(
    <OverlayPicker open mobile={false} state={{ items: [btc, opt], focusedId: btc.id }} mainAsset={mainAsset} {...handlers} {...props} />,
  );
  return handlers;
}

beforeEach(() => {
  marketApi.getCatalog.mockResolvedValue(CATALOG);
  marketApi.getOptionExpiries.mockResolvedValue([]);
});
afterEach(() => { vi.clearAllMocks(); });

describe('mainUnderlyingOf', () => {
  it('quita los sufijos de cotización', () => {
    expect(mainUnderlyingOf({ symbol: 'ETHUSDT' })).toBe('ETH');
    expect(mainUnderlyingOf({ symbol: 'BTC-PERP' })).toBe('BTC');
    expect(mainUnderlyingOf({ symbol: 'solusdc' })).toBe('SOL');
    expect(mainUnderlyingOf({ symbol: 'HYPE' })).toBe('HYPE');
    expect(mainUnderlyingOf({ symbol: 'BNBUSD' })).toBe('BNB');
  });
});

describe('OverlayPicker (escritorio)', () => {
  it('es un diálogo con pestañas, contador y foco dentro', async () => {
    renderPicker();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Activo' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('2 de 6 en uso')).toBeTruthy();
    await screen.findByText('XRP/USDT');
  });

  it('la pestaña Activo no lista el principal', async () => {
    renderPicker();
    await screen.findByText('XRP/USDT');
    expect(screen.queryByText('ETH/USDT')).toBeNull();
  });

  it('"En el gráfico" lista las superposiciones y "Añadido" las quita', async () => {
    const h = renderPicker();
    const section = screen.getByRole('region', { name: 'En el gráfico' });
    expect(within(section).getByText('BTC/USDT')).toBeTruthy();
    expect(within(section).getByText('ETH 31 oct · C 2500')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Quitar BTC/USDT' }));
    expect(h.onRemove).toHaveBeenCalledWith(btc.id);
  });

  it('"+ Añadir" en el catálogo llama a onAdd con la especificación de activo', async () => {
    const h = renderPicker();
    fireEvent.click(await screen.findByRole('button', { name: 'Añadir XRP/USDT' }));
    expect(h.onAdd).toHaveBeenCalledWith({ kind: 'asset', asset: { symbol: 'XRPUSDT', datasource: 'binance', name: 'XRP' } });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('búsqueda y categorías filtran el catálogo', async () => {
    renderPicker();
    await screen.findByText('XRP/USDT');
    fireEvent.click(screen.getByRole('button', { name: /Commodities/ }));
    expect(screen.queryByText('XRP/USDT')).toBeNull();
    expect(screen.getByText('GC=F')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Todos/ }));
    fireEvent.change(screen.getByPlaceholderText('Buscar activo'), { target: { value: 'xrp' } });
    expect(screen.getByText('XRP/USDT')).toBeTruthy();
    expect(screen.queryByText('GC=F')).toBeNull();
  });

  it('con 6 superposiciones los "+ Añadir" se desactivan y explican el límite', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ ...btc, id: `asset:binance:X${i}`, asset: { ...btc.asset, symbol: `X${i}USDT` } }));
    renderPicker({ state: { items, focusedId: null } });
    const add = await screen.findByRole('button', { name: 'Añadir XRP/USDT' });
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('title')).toBe('Máximo 6 superposiciones');
  });

  it('Esc y "Listo" cierran', async () => {
    const h = renderPicker();
    await screen.findByText('XRP/USDT');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it('la pestaña Opción muestra el navegador de Deribit con el subyacente del principal', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'Opción · Deribit' }));
    expect(screen.getByRole('button', { name: 'ETH' }).getAttribute('aria-pressed')).toBe('true');
    expect(marketApi.getOptionExpiries).toHaveBeenCalledWith('ETH');
  });

  it('trampa de foco: Tab y Mayús+Tab no salen del diálogo', async () => {
    renderPicker();
    await screen.findByText('XRP/USDT');
    const dialog = screen.getByRole('dialog');
    const done = screen.getByRole('button', { name: 'Listo' });
    const close = screen.getByRole('button', { name: 'Cerrar' });
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('al abrir enfoca el buscador y al cerrar devuelve el foco al disparador', async () => {
    const props = { mobile: false, state: { items: [btc], focusedId: btc.id }, mainAsset, onAdd: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<><button type="button">Superponer</button><OverlayPicker open={false} {...props} /></>);
    const trigger = screen.getByRole('button', { name: 'Superponer' });
    trigger.focus();
    rerender(<><button type="button">Superponer</button><OverlayPicker open {...props} /></>);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Buscar activo'));
    await screen.findByText('XRP/USDT');
    rerender(<><button type="button">Superponer</button><OverlayPicker open={false} {...props} /></>);
    expect(document.activeElement).toBe(trigger);
  });

  it('cerrado no renderiza nada', () => {
    renderPicker({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('OverlayPicker (móvil)', () => {
  it('se abre en BottomSheet con "Superponer", el contador y la pestaña Opción en pasos', async () => {
    renderPicker({ mobile: true });
    const sheet = screen.getByRole('dialog', { name: 'Superponer' });
    expect(within(sheet).getByText('2 de 6')).toBeTruthy();
    await screen.findByText('XRP/USDT');
    fireEvent.click(screen.getByRole('tab', { name: 'Opción · Deribit' }));
    expect(screen.getByText('Paso 1 de 3 · Subyacente')).toBeTruthy();
  });
});
