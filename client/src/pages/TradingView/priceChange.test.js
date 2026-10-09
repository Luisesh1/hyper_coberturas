import { describe, expect, it } from 'vitest';
import { computePriceChange } from './priceChange';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Velas horarias consecutivas con cierre = base + índice.
function hourly(count, base = 100, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * HOUR,
    open: base + i,
    high: base + i,
    low: base + i,
    close: base + i,
  }));
}

describe('computePriceChange', () => {
  it('usa el cierre de la vela de hace 24h como referencia', () => {
    const candles = hourly(30); // última vela: t = 29h, cierre 129
    // Referencia: última vela con time <= 5h → cierre 105.
    const res = computePriceChange(candles);
    expect(res.reference).toBe(105);
    expect(res.current).toBe(129);
    expect(res.change).toBe(24);
    expect(res.percent).toBeCloseTo((24 / 105) * 100, 10);
  });

  it('prefiere el precio en vivo como actual cuando existe', () => {
    const res = computePriceChange(hourly(30), 110);
    expect(res.current).toBe(110);
    expect(res.change).toBe(5);
  });

  it('ignora un precio en vivo no numérico', () => {
    expect(computePriceChange(hourly(30), null).current).toBe(129);
    expect(computePriceChange(hourly(30), Number.NaN).current).toBe(129);
  });

  it('acepta la vela exactamente 24h antes', () => {
    const candles = hourly(25); // última t = 24h; objetivo t = 0
    expect(computePriceChange(candles).reference).toBe(100);
  });

  it('devuelve null si las velas no alcanzan 24h atrás', () => {
    // 500 velas de 1m ≈ 8h de historia.
    const candles = Array.from({ length: 500 }, (_, i) => ({
      time: i * 60_000, open: 1, high: 1, low: 1, close: 1,
    }));
    expect(computePriceChange(candles, 2)).toBeNull();
    expect(computePriceChange(hourly(24))).toBeNull();
  });

  it('devuelve null si las velas duran más de 24h (1W/1M no tienen ventana de 24h)', () => {
    const weekly = Array.from({ length: 10 }, (_, i) => ({
      time: i * 7 * DAY, open: 1, high: 1, low: 1, close: 1 + i,
    }));
    expect(computePriceChange(weekly)).toBeNull();
  });

  it('en velas diarias compara con el cierre de la vela anterior', () => {
    const daily = Array.from({ length: 5 }, (_, i) => ({
      time: i * DAY, open: 1, high: 1, low: 1, close: 10 + i,
    }));
    const res = computePriceChange(daily);
    expect(res.reference).toBe(13);
    expect(res.change).toBe(1);
  });

  it('devuelve null con entradas vacías o referencia inválida', () => {
    expect(computePriceChange([])).toBeNull();
    expect(computePriceChange(null)).toBeNull();
    expect(computePriceChange(undefined, 5)).toBeNull();
    const zeroRef = hourly(30, 0).map((c, i) => (i === 5 ? { ...c, close: 0 } : c));
    expect(computePriceChange(zeroRef)).toBeNull();
  });
});
