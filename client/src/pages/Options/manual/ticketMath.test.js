import { describe, expect, it } from 'vitest';
import { computeTicket, parseSymbol, priceStep, qtyStep, quoteFor, snapToTick, stepOnTick, tickError } from './ticketMath';
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

describe('rejilla de precios (PRICE_FILTER)', () => {
  const btc = { tickSize: 5, minPrice: 115, maxPrice: 990 };
  const eth = { tickSize: 0.1, minPrice: 0.2 };

  it('ajusta al tick anclado en minPrice', () => {
    expect(snapToTick(548, btc)).toBe(550);
    expect(snapToTick(548, btc, 'down')).toBe(545);
    expect(snapToTick(546, btc, 'up')).toBe(550);
    expect(snapToTick(12.34, eth)).toBe(12.3);
    expect(snapToTick(548, {})).toBe(548);
  });

  it('el stepper avanza por ticks desde precios fuera de rejilla', () => {
    expect(stepOnTick(548, btc, 1)).toBe(550);
    expect(stepOnTick(548, btc, -1)).toBe(545);
    expect(stepOnTick(545, btc, 1)).toBe(550);
    expect(stepOnTick(115, btc, -1)).toBe(115);
    expect(stepOnTick(0.3, eth, 1)).toBe(0.4);
  });

  it('explica el error con los precios válidos más cercanos', () => {
    expect(tickError(548, btc)).toBe('Múltiplos de 5 USDT: prueba 545 o 550.');
    expect(tickError(545, btc)).toBeNull();
    expect(tickError(100, btc)).toMatch(/mínimo/);
    expect(tickError(1000, btc)).toMatch(/máximo/);
    expect(tickError(548, {})).toBeNull();
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
