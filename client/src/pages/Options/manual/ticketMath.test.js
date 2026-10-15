import { describe, expect, it } from 'vitest';
import { computeTicket, parseSymbol, priceStep, qtyStep, quoteFor } from './ticketMath';
import { fmtIv, fmtNum, fmtPrice, fmtSigned } from '../format';

describe('ticketMath', () => {
  const leg = { symbol: 'BTC-261031-70000-C', bid: 900, ask: 920, mark: 910, delta: 0.4, theta: -20 };

  it('compra: paga prima, sin margen, griegas con signo positivo', () => {
    const t = computeTicket({ side: 'BUY', type: 'C', strike: 70000, price: 920, qty: 0.5, spot: 68000, leg });
    expect(t.valid).toBe(true);
    expect(t.premium).toBeCloseTo(-460);
    // mín(0,03 % de 68000 × 0,5 = 10,2 ; 10 % de 460 = 46)
    expect(t.fee).toBeCloseTo(10.2);
    expect(t.margin).toBeNull();
    expect(t.delta).toBeCloseTo(0.2);
    expect(t.theta).toBeCloseTo(-10);
    expect(t.breakeven).toBe(70920);
  });

  it('venta: cobra prima, estima margen y break-even del put', () => {
    const t = computeTicket({ side: 'SELL', type: 'P', strike: 64000, price: 100, qty: 1, spot: 68000, leg: { mark: 100, delta: -0.2, theta: -5 } });
    expect(t.premium).toBeCloseTo(100);
    // comisión limitada al 10 % de la prima
    expect(t.fee).toBeCloseTo(10);
    // OTM 4000: mark 100 + máx(10200 − 4000, 6800) = 6900
    expect(t.margin).toBeCloseTo(6900);
    expect(t.delta).toBeCloseTo(0.2);
    expect(t.theta).toBeCloseTo(5);
    expect(t.breakeven).toBe(63900);
  });

  it('precio o cantidad inválidos → ticket no válido', () => {
    expect(computeTicket({ side: 'BUY', type: 'C', strike: 1, price: null, qty: 1, spot: 1 }).valid).toBe(false);
    expect(computeTicket({ side: 'BUY', type: 'C', strike: 1, price: 1, qty: 0, spot: 1 }).valid).toBe(false);
  });

  it('quoteFor: ask para comprar, bid para vender, mark si no hay libro', () => {
    expect(quoteFor(leg, 'BUY')).toBe(920);
    expect(quoteFor(leg, 'SELL')).toBe(900);
    expect(quoteFor({ bid: 0, ask: null, mark: 5 }, 'SELL')).toBe(5);
    expect(quoteFor(null, 'BUY')).toBeNull();
  });

  it('pasos de precio y cantidad', () => {
    expect(priceStep(1180)).toBe(10);
    expect(priceStep(62.4)).toBe(0.1);
    expect(priceStep(0.0123)).toBe(0.0001);
    expect(qtyStep(0.5)).toBe(0.1);
    expect(qtyStep(0.05)).toBe(0.01);
    expect(qtyStep(0.1, -1)).toBe(0.01);
  });

  it('parseSymbol', () => {
    expect(parseSymbol('ETH-261128-2200-P')).toEqual({ underlying: 'ETH', expiry: '261128', strike: 2200, type: 'P' });
    expect(parseSymbol('nope')).toBeNull();
  });
});

describe('format', () => {
  it('es-ES con miles, signo y IV', () => {
    expect(fmtNum(1180, 0)).toBe('1.180');
    expect(fmtSigned(-25, 2)).toBe('−25,00');
    expect(fmtSigned(137.5, 2)).toBe('+137,50');
    expect(fmtPrice(62.4)).toBe('62,4');
    expect(fmtPrice(905)).toBe('905');
    expect(fmtPrice(0.0012)).toBe('0,00120');
    expect(fmtIv(0.523)).toBe('52,3 %');
    expect(fmtIv(52.3)).toBe('52,3 %');
    expect(fmtNum(null)).toBe('—');
  });
});
