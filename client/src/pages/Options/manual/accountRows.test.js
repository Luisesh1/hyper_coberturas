import { describe, expect, it } from 'vitest';
import { positionView, tradeView } from './accountRows';
import { parseClosePrice } from './CloseAtPriceForm';

describe('valores de posiciones de opciones', () => {
  const position = {
    symbol: 'BTC-261018-82000-C',
    side: 'LONG',
    quantity: 0.1,
    entryPrice: 500,
    markPrice: 650,
    unrealizedPnl: 15,
  };

  it('calcula la prima actual con mark × contratos, sin sumar el P&L dos veces', () => {
    const p = positionView(position);
    expect(p.entry).toBe(500);
    expect(p.mark).toBe(650);
    expect(p.premiumCurrent).toBeCloseTo(65);
    expect(p.pnl).toBe(15);
  });

  it('funciona para posiciones short y no muestra cero falso si falta mark', () => {
    expect(positionView({ ...position, side: 'SHORT', quantity: -0.1 }).premiumCurrent).toBeCloseTo(65);
    expect(positionView({ ...position, markPrice: null }).premiumCurrent).toBeNull();
    expect(positionView({ ...position, markPrice: 'abc' }).premiumCurrent).toBeNull();
  });

  it('acepta precios positivos con coma o punto y rechaza texto inválido', () => {
    expect(parseClosePrice('850,5')).toBe(850.5);
    expect(parseClosePrice('850.5')).toBe(850.5);
    expect(parseClosePrice('0,0001')).toBe(0.0001);
    expect(parseClosePrice('-12')).toBeNull();
    expect(parseClosePrice('0')).toBeNull();
    expect(parseClosePrice('abc')).toBeNull();
  });
});

describe('prima total de las ejecuciones', () => {
  it('es precio × contratos', () => {
    expect(tradeView({ symbol: 'X', side: 'BUY', price: '55', quantity: '0.7' }, 0).premiumTotal).toBeCloseTo(38.5);
  });

  it('sin precio no inventa un cero', () => {
    expect(tradeView({ symbol: 'X', side: 'BUY', quantity: 1 }, 0).premiumTotal).toBeNull();
  });
});
