import { describe, expect, it } from 'vitest';
import { formatIndicatorLabel } from './formatLabel';

describe('formatIndicatorLabel', () => {
  it('usa los parámetros reales del MACD (fast/slow/signal del catálogo)', () => {
    expect(formatIndicatorLabel('macd', { fast: 8, slow: 21, signal: 5 }, 'MACD')).toBe('MACD 8/21/5');
  });

  it('usa los parámetros reales del Stochastic (kLength/dLength del catálogo)', () => {
    expect(formatIndicatorLabel('stoch', { kLength: 9, dLength: 4, smooth: 3 }, 'Stoch')).toBe('Stoch 9/4');
  });

  it('cae a los valores por defecto si faltan parámetros', () => {
    expect(formatIndicatorLabel('macd', {}, 'MACD')).toBe('MACD 12/26/9');
    expect(formatIndicatorLabel('stoch', undefined, 'Stoch')).toBe('Stoch 14/3');
  });

  it('mantiene los formatos existentes', () => {
    expect(formatIndicatorLabel('bollinger', { length: 30, stdDev: 2.5 }, 'BB')).toBe('BB 30/2.5');
    expect(formatIndicatorLabel('keltner', { length: 20, atrLength: 14 }, 'KC')).toBe('KC 20/14');
    expect(formatIndicatorLabel('ema', { length: 50 }, 'EMA')).toBe('EMA 50');
    expect(formatIndicatorLabel('volume', {}, 'Volume')).toBe('Vol');
    expect(formatIndicatorLabel('vwap', {}, 'VWAP')).toBe('VWAP');
  });
});
