import { describe, it, expect } from 'vitest';
import { computeIndicator } from './computeAdapter';

// Construye un array de candles simples para smoke-test.
// time en ms (como vienen del backend).
function makeCandles(closes, volumes = null) {
  return closes.map((c, i) => ({
    time: 1700000000000 + i * 60_000,
    open: c, high: c + 1, low: c - 1, close: c,
    volume: volumes ? volumes[i] : 10,
  }));
}

function makeSqzmomCandles(length = 80) {
  const closes = Array.from({ length }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.12);
  return makeCandles(closes);
}

describe('computeAdapter', () => {
  it('SMA(5) produce N-4 puntos con valor correcto', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7]);
    const out = computeIndicator('sma', candles, { length: 5 });
    expect(out.series).toHaveLength(1);
    const data = out.series[0].data;
    expect(data).toHaveLength(3); // 7 - 5 + 1
    // SMA(5) de [1..5]=3, [2..6]=4, [3..7]=5
    expect(data[0].value).toBeCloseTo(3);
    expect(data[1].value).toBeCloseTo(4);
    expect(data[2].value).toBeCloseTo(5);
  });

  it('EMA(3) produce serie alineada a la derecha', () => {
    const candles = makeCandles([1, 2, 3, 4, 5]);
    const out = computeIndicator('ema', candles, { length: 3 });
    expect(out.series[0].data.length).toBeGreaterThan(0);
    // Todos los valores finitos
    for (const p of out.series[0].data) {
      expect(Number.isFinite(p.value)).toBe(true);
    }
  });

  it('RSI(14) requiere al menos 15 candles', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 0.5);
    const out = computeIndicator('rsi', makeCandles(closes), { length: 14 });
    expect(out.series[0].data.length).toBeGreaterThan(0);
    // RSI siempre está entre 0 y 100
    for (const p of out.series[0].data) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
  });

  it('RSI devuelve referencias alta y baja configurables', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3));
    const out = computeIndicator('rsi', makeCandles(closes), {
      length: 14,
      highLevel: 75,
      lowLevel: 25,
    });
    const rsi = out.series.find((s) => s.role === 'line');
    const high = out.series.find((s) => s.role === 'highLevel');
    const low = out.series.find((s) => s.role === 'lowLevel');

    expect(high.data).toHaveLength(rsi.data.length);
    expect(low.data).toHaveLength(rsi.data.length);
    expect(high.data.every((p) => p.value === 75)).toBe(true);
    expect(low.data.every((p) => p.value === 25)).toBe(true);
    expect(high.data[0].time).toEqual(rsi.data[0].time);
    expect(low.data.at(-1).time).toEqual(rsi.data.at(-1).time);
  });

  it('MACD devuelve tres sub-series (macd, signal, histogram)', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const out = computeIndicator('macd', makeCandles(closes), { fast: 12, slow: 26, signal: 9 });
    const roles = out.series.map((s) => s.role).sort();
    expect(roles).toEqual(['histogram', 'macd', 'signal']);
    for (const s of out.series) expect(s.data.length).toBeGreaterThan(0);
  });

  it('Bollinger devuelve upper/middle/lower alineados', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.random());
    const out = computeIndicator('bollinger', makeCandles(closes), { length: 20, stdDev: 2 });
    const upper = out.series.find((s) => s.role === 'upper');
    const middle = out.series.find((s) => s.role === 'middle');
    const lower = out.series.find((s) => s.role === 'lower');
    expect(upper.data.length).toEqual(middle.data.length);
    expect(lower.data.length).toEqual(middle.data.length);
    // Upper >= Middle >= Lower
    for (let i = 0; i < middle.data.length; i += 1) {
      expect(upper.data[i].value).toBeGreaterThanOrEqual(middle.data[i].value);
      expect(middle.data[i].value).toBeGreaterThanOrEqual(lower.data[i].value);
    }
  });

  it('ATR es siempre positivo', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const out = computeIndicator('atr', makeCandles(closes), { length: 14 });
    for (const p of out.series[0].data) {
      expect(p.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('VWAP es monótono en valor (promedio ponderado acumulado)', () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const out = computeIndicator('vwap', makeCandles(closes));
    expect(out.series[0].data).toHaveLength(10);
    // VWAP de precios crecientes iguales volumen debe ser creciente
    for (let i = 1; i < out.series[0].data.length; i += 1) {
      expect(out.series[0].data[i].value).toBeGreaterThanOrEqual(out.series[0].data[i - 1].value);
    }
  });

  it('Volume devuelve un punto por candle', () => {
    const candles = makeCandles([1, 2, 3, 4, 5], [100, 200, 150, 300, 50]);
    const out = computeIndicator('volume', candles);
    expect(out.series[0].data).toHaveLength(5);
    expect(out.series[0].data[3].value).toEqual(300);
    expect(out.series[0].data[3].color).toContain('38, 166, 154'); // close >= open → verde
  });

  it('devuelve null para tipos desconocidos', () => {
    const out = computeIndicator('foobar', makeCandles([1, 2, 3]));
    expect(out).toBeNull();
  });

  it('ADX devuelve adx/pdi/mdi entre 0 y 100', () => {
    const highs = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const candles = highs.map((h, i) => ({
      time: 1700000000000 + i * 60_000,
      open: h - 0.5, high: h, low: h - 2, close: h - 0.2, volume: 10,
    }));
    const out = computeIndicator('adx', candles, { length: 14 });
    for (const s of out.series) {
      for (const p of s.data) {
        expect(p.value).toBeGreaterThanOrEqual(0);
        expect(p.value).toBeLessThanOrEqual(100);
      }
    }
  });

  it('ADX permite ocultar partes desde params', () => {
    const highs = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const candles = highs.map((h, i) => ({
      time: 1700000000000 + i * 60_000,
      open: h - 0.5, high: h, low: h - 2, close: h - 0.2, volume: 10,
    }));
    const out = computeIndicator('adx', candles, {
      length: 14,
      showADX: false,
      showDIPlus: true,
      showDIMinus: false,
    });
    expect(out.series.map((s) => s.role)).toEqual(['pdi']);
    expect(out.series[0].data.length).toBeGreaterThan(0);
  });

  it('SQZMOM devuelve lineas superior e inferior por defecto', () => {
    const out = computeIndicator('sqzmom', makeSqzmomCandles(), {
      normalBandLength: 5,
    });
    expect(out.series.map((s) => s.role)).toEqual(['histogram', 'sqzDots', 'normalUpper', 'normalLower']);
    expect(out.series.find((s) => s.role === 'normalUpper').data.length).toBeGreaterThan(0);
    expect(out.series.find((s) => s.role === 'normalLower').data.length).toBeGreaterThan(0);
  });

  it('SQZMOM muestra la linea media solo cuando se habilita', () => {
    const out = computeIndicator('sqzmom', makeSqzmomCandles(), {
      normalBandLength: 5,
      showNormalMiddle: true,
    });
    expect(out.series.map((s) => s.role)).toEqual([
      'histogram',
      'sqzDots',
      'normalUpper',
      'normalMiddle',
      'normalLower',
    ]);
    expect(out.series.find((s) => s.role === 'normalMiddle').data.length).toBeGreaterThan(0);
  });

  it('SQZMOM permite ocultar cada linea de banda de forma independiente', () => {
    const out = computeIndicator('sqzmom', makeSqzmomCandles(), {
      normalBandLength: 5,
      showNormalUpper: false,
      showNormalMiddle: true,
      showNormalLower: false,
    });
    expect(out.series.map((s) => s.role)).toEqual(['histogram', 'sqzDots', 'normalMiddle']);
  });

  it('SQZMOM inicia la banda normal despues de completar la ventana movil', () => {
    const normalBandLength = 7;
    const out = computeIndicator('sqzmom', makeSqzmomCandles(), { normalBandLength });
    const hist = out.series.find((s) => s.role === 'histogram').data;
    const upper = out.series.find((s) => s.role === 'normalUpper').data;
    const lower = out.series.find((s) => s.role === 'normalLower').data;

    expect(upper).toHaveLength(hist.length - normalBandLength + 1);
    expect(lower).toHaveLength(upper.length);
    expect(upper[0].time).toEqual(hist[normalBandLength - 1].time);

    for (let i = 0; i < upper.length; i += 1) {
      expect(upper[i].value).toBeGreaterThanOrEqual(lower[i].value);
    }
  });
});
