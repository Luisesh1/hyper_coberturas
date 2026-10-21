import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OverlayChips from './OverlayChips';

const btc = { id: 'asset:binance:BTCUSDT', kind: 'asset', color: '#f59e0b', hidden: false, asset: { symbol: 'BTCUSDT', datasource: 'binance', name: 'BTC' } };
const sol = { id: 'asset:binance:SOLUSDT', kind: 'asset', color: '#22d3ee', hidden: false, asset: { symbol: 'SOLUSDT', datasource: 'binance', name: 'SOL' } };
const opt = {
  id: 'option:ETH-31OCT26-2500-C', kind: 'option', color: '#a78bfa', hidden: false,
  option: { instrument: 'ETH-31OCT26-2500-C', underlying: 'ETH', expiryMs: Date.UTC(2026, 9, 31, 8), strike: 2500, type: 'C' },
};

function renderChips(props = {}) {
  const handlers = {
    onFocus: vi.fn(), onToggleHidden: vi.fn(), onRemove: vi.fn(), onSwap: vi.fn(),
    onColor: vi.fn(), onAdd: vi.fn(), onRetry: vi.fn(),
  };
  const overlays = props.overlays ?? [btc, sol, opt];
  const status = props.status ?? Object.fromEntries(overlays.map((o) => [o.id, 'ready']));
  render(
    <OverlayChips
      overlays={overlays}
      focusedId={btc.id}
      status={status}
      values={[
        { id: btc.id, value: 110954.2, changePct: 0.2 },
        { id: sol.id, value: 207.09, changePct: -0.6 },
        { id: opt.id, value: 17.42, changePct: 9.2 },
      ]}
      mainLabel="ETH/USDT"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('OverlayChips', () => {
  it('clic en el cuerpo de un chip no enfocado lo enfoca', () => {
    const h = renderChips();
    fireEvent.click(screen.getByRole('button', { name: 'SOL/USDT' }));
    expect(h.onFocus).toHaveBeenCalledWith(sol.id);
  });

  it('el enfocado indica "eje izq." y muestra el valor', () => {
    renderChips();
    const focused = screen.getByRole('button', { name: 'BTC/USDT' });
    expect(focused.getAttribute('aria-pressed')).toBe('true');
    expect(within(focused).getByText('eje izq.')).toBeTruthy();
    expect(within(focused).getByText(/110,954/)).toBeTruthy();
    expect(screen.getAllByText('eje izq.')).toHaveLength(1);
  });

  it('el menú de una opción no ofrece "Intercambiar"; el de un activo sí', () => {
    const h = renderChips();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones de ETH 31 oct · C 2500' }));
    let menu = screen.getByRole('menu');
    expect(within(menu).queryByText(/Intercambiar/)).toBeNull();
    expect(within(menu).getByText('Quitar superposición')).toBeTruthy();
    fireEvent.click(within(menu).getByText('Quitar superposición'));
    expect(h.onRemove).toHaveBeenCalledWith(opt.id);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Más acciones de SOL/USDT' }));
    menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('Intercambiar con ETH/USDT'));
    expect(h.onSwap).toHaveBeenCalledWith(sol.id);
  });

  it('menú: usar el eje izquierdo y elegir un color libre', () => {
    const h = renderChips();
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones de SOL/USDT' }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('Usar el eje izquierdo'));
    expect(h.onFocus).toHaveBeenCalledWith(sol.id);
    fireEvent.click(screen.getByRole('button', { name: 'Más acciones de SOL/USDT' }));
    const swatches = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    // propio + los 3 libres (ámbar y violeta están en uso)
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual(['Color #22d3ee', 'Color #f472b6', 'Color #a3e635', 'Color #93c5fd']);
    fireEvent.click(swatches[2]);
    expect(h.onColor).toHaveBeenCalledWith(sol.id, '#a3e635');
  });

  it('con 6 superposiciones "Añadir" queda desactivado y explica el límite', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...btc, id: `asset:binance:X${i}USDT`, asset: { ...btc.asset, symbol: `X${i}USDT` } }));
    renderChips({ overlays: many });
    const add = screen.getByRole('button', { name: /Añadir/ });
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('title')).toBe('Máximo 6 superposiciones');
  });

  it('"Añadir" llama a onAdd', () => {
    const h = renderChips();
    fireEvent.click(screen.getByRole('button', { name: /Añadir/ }));
    expect(h.onAdd).toHaveBeenCalled();
  });

  it('estados: es el principal, oculto, sin datos, error con reintento', () => {
    const h = renderChips({
      overlays: [btc, { ...sol, hidden: true }, opt, { ...btc, id: 'asset:binance:ETHUSDT', asset: { symbol: 'ETHUSDT', datasource: 'binance' } }],
      status: { [btc.id]: 'empty', [sol.id]: 'hidden', [opt.id]: 'error', 'asset:binance:ETHUSDT': 'isMain' },
    });
    expect(screen.getByText('es el principal')).toBeTruthy();
    expect(screen.getByText('oculto')).toBeTruthy();
    expect(screen.getByText('Sin datos en este rango')).toBeTruthy();
    expect(screen.queryByLabelText('Cargando')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(h.onRetry).toHaveBeenCalledWith(opt.id);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar SOL/USDT' }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(sol.id);
  });

  it('cargando muestra un indicador', () => {
    renderChips({ status: { [btc.id]: 'loading', [sol.id]: 'ready', [opt.id]: 'ready' } });
    expect(screen.getByLabelText('Cargando')).toBeTruthy();
  });
});

describe('OverlayChips (móvil)', () => {
  it('pastillas con nombre corto; el enfocado lleva "izq." y tocar otro lo enfoca', () => {
    const h = renderChips({ mobile: true });
    const focused = screen.getByRole('button', { name: /BTC\/USDT/ });
    expect(within(focused).getByText('izq.')).toBeTruthy();
    expect(screen.getAllByText('izq.')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /SOL\/USDT/ }));
    expect(h.onFocus).toHaveBeenCalledWith(sol.id);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Sin ojo ni "⋯" en móvil
    expect(screen.queryByRole('button', { name: /Más acciones/ })).toBeNull();
  });

  it('el texto visible usa la etiqueta corta móvil; el nombre accesible, la completa', () => {
    renderChips({ mobile: true, status: { [btc.id]: 'ready', [sol.id]: 'loading', [opt.id]: 'error' } });
    const group = screen.getByRole('group', { name: 'Superposiciones' });
    const b = within(group).getByRole('button', { name: 'BTC/USDT · eje izquierdo' });
    expect(within(b).getByText('BTC')).toBeTruthy();
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    const s = within(group).getByRole('button', { name: 'SOL/USDT · cargando' });
    expect(within(s).getByText('SOL')).toBeTruthy();
    expect(s.getAttribute('aria-haspopup')).toBeNull();
    const o = within(group).getByRole('button', { name: 'ETH 31 oct · C 2500 · error' });
    expect(within(o).getByText('C 2500 · 31 oct')).toBeTruthy();
  });

  it('tocar el enfocado (activo) abre "Acciones" con "Ver en grande"', () => {
    const h = renderChips({ mobile: true });
    fireEvent.click(screen.getByRole('button', { name: /BTC\/USDT/ }));
    expect(h.onFocus).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'Acciones' });
    expect(within(sheet).getByRole('button', { name: /Ocultar/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /Quitar superposición/ })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: /Ver en grande/ }));
    expect(h.onSwap).toHaveBeenCalledWith(btc.id);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tocar el enfocado (opción) abre "Acciones" sin "Ver en grande"', () => {
    const h = renderChips({ mobile: true, focusedId: opt.id });
    fireEvent.click(screen.getByRole('button', { name: /ETH 31 oct · C 2500/ }));
    const sheet = screen.getByRole('dialog', { name: 'Acciones' });
    expect(within(sheet).queryByRole('button', { name: /Ver en grande/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: /Ocultar/ }));
    expect(h.onToggleHidden).toHaveBeenCalledWith(opt.id);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('una oculta se ve tachada y al tocarla ofrece "Mostrar"; quitar llama a onRemove', () => {
    const h = renderChips({
      mobile: true,
      overlays: [btc, { ...sol, hidden: true }, opt],
      status: { [btc.id]: 'ready', [sol.id]: 'hidden', [opt.id]: 'ready' },
    });
    fireEvent.click(screen.getByRole('button', { name: /SOL\/USDT/ }));
    expect(h.onFocus).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'Acciones' });
    expect(within(sheet).getByRole('button', { name: /Mostrar/ })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: /Quitar superposición/ }));
    expect(h.onRemove).toHaveBeenCalledWith(sol.id);
  });

  it('el "+" redondo abre el selector', () => {
    const h = renderChips({ mobile: true });
    fireEvent.click(screen.getByRole('button', { name: 'Añadir superposición' }));
    expect(h.onAdd).toHaveBeenCalled();
  });

  it('con 6 superposiciones el "+" queda desactivado y explica el límite', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...btc, id: `asset:binance:X${i}USDT`, asset: { ...btc.asset, symbol: `X${i}USDT` } }));
    renderChips({ mobile: true, overlays: many });
    const add = screen.getByRole('button', { name: 'Máximo 6 superposiciones' });
    expect(add.disabled).toBe(true);
  });
});
