import { describe, expect, it } from 'vitest';
import { getInitialChartViewport } from './chartViewport';

describe('getInitialChartViewport', () => {
  it('muestra menos velas y menos espacio derecho en pantallas estrechas', () => {
    expect(getInitialChartViewport(320, 500)).toEqual({
      visibleCandles: 30,
      rightOffset: 4,
      barSpacing: 11,
    });
  });

  it('aumenta progresivamente las velas hasta el limite de escritorio', () => {
    expect(getInitialChartViewport(768, 500)).toEqual({
      visibleCandles: 69,
      rightOffset: 7,
      barSpacing: 11,
    });
    expect(getInitialChartViewport(1440, 500)).toEqual({
      visibleCandles: 95,
      rightOffset: 10,
      barSpacing: 15,
    });
  });

  it('nunca intenta mostrar mas velas de las disponibles', () => {
    expect(getInitialChartViewport(1440, 20)).toEqual({
      visibleCandles: 20,
      rightOffset: 4,
      barSpacing: 18,
    });
  });
});
