import { describe, expect, it } from 'vitest';
import { formatParams } from './formatParams';

describe('formatParams', () => {
  it('usa las etiquetas del esquema para los números', () => {
    expect(formatParams({ type: 'bollinger', params: { length: 20, stdDev: 2 } }))
      .toBe('Periodo 20 · Desv. estándar 2');
    expect(formatParams({ type: 'macd', params: { fast: 12, slow: 26, signal: 9 } }))
      .toBe('Rápida 12 · Lenta 26 · Señal 9');
  });

  it('muestra solo la etiqueta de los booleanos activos y omite los falsos', () => {
    const params = { length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true };
    expect(formatParams({ type: 'sqzmom', params }, { max: 10 }))
      .toBe('BB periodo 20 · BB desv. 2 · KC periodo 20 · KC mult. 1.5 · Usar True Range');
    expect(formatParams({ type: 'sqzmom', params: { ...params, useTrueRange: false } }, { max: 10 }))
      .toBe('BB periodo 20 · BB desv. 2 · KC periodo 20 · KC mult. 1.5');
  });

  it('omite los interruptores de visibilidad («show…»): no cambian el cálculo', () => {
    expect(formatParams({ type: 'adx', params: { length: 14, showADX: true, showDIPlus: true, showDIMinus: false } }))
      .toBe('Periodo 14');
  });

  it('omite los valores ausentes', () => {
    expect(formatParams({ type: 'rsi', params: { length: 14, lowLevel: 30 } }))
      .toBe('Periodo 14 · Valor bajo RSI 30');
  });

  it('limita a 3 elementos y resume el resto con «+N»', () => {
    const params = {
      length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true,
      showNormalUpper: true, showNormalMiddle: false, showNormalLower: true,
      normalBandLength: 100, normalBandSigma: 2,
    };
    expect(formatParams({ type: 'sqzmom', params }))
      .toBe('BB periodo 20 · BB desv. 2 · KC periodo 20 · +4');
  });

  it('no añade «+N» si cabe justo en el límite', () => {
    expect(formatParams({ type: 'rsi', params: { length: 14, highLevel: 70, lowLevel: 30 } }))
      .toBe('Periodo 14 · Valor alto RSI 70 · Valor bajo RSI 30');
  });

  it('cae al nombre completo si no queda nada que mostrar', () => {
    expect(formatParams({ type: 'vwap', params: {} })).toBe('Volume Weighted Average Price');
    expect(formatParams({ type: 'adx', params: { showADX: true } })).toBe('Average Directional Index');
    expect(formatParams({ type: 'sma' })).toBe('Simple Moving Average');
  });

  it('devuelve cadena vacía para tipos desconocidos', () => {
    expect(formatParams({ type: 'nope', params: { length: 3 } })).toBe('');
  });
});
