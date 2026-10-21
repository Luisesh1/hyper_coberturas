import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MobileChain, { isItm } from './MobileChain';
import OptionChain from './OptionChain';

const leg = (symbol) => ({ symbol, bid: 10, ask: 12, iv: 0.5, delta: 0.5 });
const chain = {
  spot: 1000,
  expiries: [],
  rows: [
    { strike: 900, call: leg('X-261030-900-C'), put: leg('X-261030-900-P') },
    { strike: 1100, call: leg('X-261030-1100-C'), put: leg('X-261030-1100-P') },
  ],
};

describe('sombreado de opciones dentro del dinero', () => {
  it('call ITM bajo el spot, put ITM sobre el spot', () => {
    expect(isItm('C', 90, 100)).toBe(true);
    expect(isItm('C', 110, 100)).toBe(false);
    expect(isItm('P', 110, 100)).toBe(true);
    expect(isItm('P', 90, 100)).toBe(false);
    expect(isItm('C', 90, null)).toBe(false);
  });

  it('móvil marca las filas ITM del lado elegido', () => {
    const { rerender } = render(<MobileChain chain={chain} type="C" onType={() => {}} onPickRow={() => {}} />);
    expect(screen.getByRole('button', { name: /^Call 900, dentro del dinero/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Call 1.100, bid/ })).toBeTruthy();
    rerender(<MobileChain chain={chain} type="P" onType={() => {}} onPickRow={() => {}} />);
    expect(screen.getByRole('button', { name: /^Put 1.100, dentro del dinero/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Put 900, bid/ })).toBeTruthy();
  });

  it('escritorio sombrea el lado call o put ITM de cada fila', () => {
    render(<OptionChain chain={chain} expiry="261030" onExpiry={() => {}} onPick={() => {}} />);
    const [low, spotRow, high] = screen.getAllByRole('row').slice(2);
    expect(spotRow.textContent).toMatch(/Spot/);
    expect(low.className).toMatch(/itmCall/);
    expect(low.className).not.toMatch(/itmPut/);
    expect(high.className).toMatch(/itmPut/);
    expect(high.className).not.toMatch(/itmCall/);
  });

  it('escritorio muestra el apalancamiento por prima de calls y puts, como en móvil', () => {
    render(<OptionChain chain={chain} expiry="261030" onExpiry={() => {}} onPick={() => {}} />);
    expect(screen.getAllByRole('columnheader', { name: 'Apal.' })).toHaveLength(2);
    const [low] = screen.getAllByRole('row').slice(2);
    // spot 1000 / ask 12 = 83,3x en ambos lados
    expect(low.textContent.match(/83,3x/g)).toHaveLength(2);
  });
});
