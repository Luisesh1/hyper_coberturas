import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { buildChainMarks, expiryOfSymbol, markShort } from './chainMarks';
import ExpiryPills from './ExpiryPills';
import MobileChain from './MobileChain';
import OptionChain from './OptionChain';

const positions = [
  { symbol: 'BTC-261023-81000-C', side: 'LONG', quantity: 0.7, entryPrice: 3475, markPrice: 3640, unrealizedPnl: 115.5 },
  { symbol: 'BTC-261023-79000-P', side: 'SHORT', quantity: -0.1, entryPrice: 14, markPrice: 12, unrealizedPnl: 0.2 },
];
const openOrders = [
  { symbol: 'BTC-261023-81500-C', orderId: 1, side: 'BUY', price: 3100, quantity: 0.1, executedQty: 0 },
  { symbol: 'BTC-261030-80000-P', orderId: 2, side: 'SELL', price: 18, quantity: 0.2, executedQty: 0 },
];

const leg = (symbol) => ({ symbol, bid: 10, ask: 12, iv: 0.5, delta: 0.5 });
const row = (k) => ({ strike: k, call: leg(`BTC-261023-${k}-C`), put: leg(`BTC-261023-${k}-P`) });
const chain = { spot: 84000, expiries: [], rows: [row(79000), row(81000), row(81500)] };

describe('distintivos de posiciones y órdenes en la cadena', () => {
  it('agrupa por símbolo y cuenta por vencimiento', () => {
    const m = buildChainMarks(positions, openOrders);
    expect(expiryOfSymbol('BTC-261023-81000-C')).toBe('261023');
    expect(m.bySymbol.get('BTC-261023-81000-C').position).toMatchObject({ long: true, qty: 0.7 });
    expect(m.bySymbol.get('BTC-261023-79000-P').position.long).toBe(false);
    expect(m.bySymbol.get('BTC-261023-81500-C').orders).toEqual([{ buy: true, qty: 0.1, price: 3100 }]);
    expect(m.byExpiry.get('261023')).toEqual({ positions: 2, orders: 1 });
    expect(m.byExpiry.get('261030')).toEqual({ positions: 0, orders: 1 });
    expect(markShort(m.bySymbol.get('BTC-261023-81000-C'))).toBe('+0,70');
    expect(markShort(m.bySymbol.get('BTC-261023-79000-P'))).toBe('−0,10');
    expect(markShort(m.bySymbol.get('BTC-261023-81500-C'))).toBe('@ 3.100');
  });

  it('ignora posiciones con cantidad cero', () => {
    const m = buildChainMarks([{ symbol: 'BTC-261023-81000-C', side: 'LONG', quantity: 0 }], []);
    expect(m.bySymbol.size).toBe(0);
  });

  it('escritorio marca la pata con ★ o ▲ junto al strike', () => {
    render(<OptionChain chain={chain} expiry="261023" onExpiry={() => {}} onPick={() => {}} marks={buildChainMarks(positions, openOrders)} />);
    const [r79, r81, r815] = screen.getAllByRole('row').slice(2);
    expect(within(r81).getByLabelText(/Posición abierta: compra 0,70/)).toBeTruthy();
    expect(within(r79).getByLabelText(/Posición abierta: venta 0,10/)).toBeTruthy();
    expect(within(r815).getByLabelText(/Orden de compra 0,10/).className).toMatch(/badgeBuy/);
  });

  it('el vencimiento muestra cuántas posiciones y órdenes tiene', () => {
    const expiries = [{ code: '261023', label: '23 oct 26' }, { code: '261030', label: '30 oct 26' }];
    render(<ExpiryPills expiries={expiries} value="261023" onChange={() => {}} marks={buildChainMarks(positions, openOrders).byExpiry} />);
    const [d23, d30] = screen.getAllByRole('button');
    expect(within(d23).getByLabelText('2 con posición abierta').textContent).toBe('2');
    expect(within(d23).getByLabelText('1 órdenes pendientes')).toBeTruthy();
    expect(within(d30).queryByLabelText(/posición abierta/)).toBeNull();
  });

  it('móvil resume la posición bajo el strike', () => {
    render(<MobileChain chain={chain} type="C" onType={() => {}} onPickRow={() => {}} marks={buildChainMarks(positions, openOrders)} />);
    const btn = screen.getByRole('button', { name: /^Call 81.000.*Posición abierta: compra 0,70/ });
    expect(btn.textContent).toMatch(/\+0,70/);
    expect(screen.getByRole('button', { name: /^Call 81.500.*Orden de compra 0,10/ }).textContent).toMatch(/@ 3\.100/);
  });
});
