import { describe, it, expect } from 'vitest';
import { DAY_MS, jumpTarget, forwardWindow, logicalRangeFor, mergeCandles } from './historyJump';

const EXP = Date.UTC(2026, 0, 30, 8);
const opt = (expiryMs) => ({ kind: 'option', option: { instrument: 'ETH-30JAN26-3000-C', expiryMs } });

describe('jumpTarget', () => {
  it('opción vencida antes de la primera vela: carga hasta vencimiento + 1 d y encuadra los 7 d previos', () => {
    expect(jumpTarget(opt(EXP), EXP + 10 * DAY_MS)).toEqual({
      endTime: EXP + DAY_MS,
      range: { from: EXP - 7 * DAY_MS, to: EXP },
    });
  });
  it('sin salto si la opción vence dentro del tramo cargado, para activos o sin velas', () => {
    expect(jumpTarget(opt(EXP), EXP - DAY_MS)).toBeNull();
    expect(jumpTarget({ kind: 'asset', asset: { symbol: 'BTCUSDT' } }, EXP + 10 * DAY_MS)).toBeNull();
    expect(jumpTarget(opt(EXP), undefined)).toBeNull();
  });
});

describe('forwardWindow', () => {
  const H = 3_600_000;
  it('pide 500 velas tras la última y avisa si llega al presente', () => {
    const now = Date.UTC(2026, 9, 21);
    expect(forwardWindow(now - 1000 * H, H, now)).toEqual({ startTime: now - 1000 * H + 1, endTime: now - 500 * H, reachesNow: false });
    expect(forwardWindow(now - 100 * H, H, now)).toEqual({ startTime: now - 100 * H + 1, endTime: now, reachesNow: true });
  });
});

describe('logicalRangeFor', () => {
  const H = 3_600_000;
  const candles = Array.from({ length: 10 }, (_, i) => ({ time: i * H }));
  it('índices de la primera y última vela dentro del rango', () => {
    expect(logicalRangeFor(candles, { from: 2.5 * H, to: 6 * H })).toEqual({ from: 3, to: 6 });
  });
  it('rango que se sale por la derecha termina en la última vela; sin velas, null', () => {
    expect(logicalRangeFor(candles, { from: 8 * H, to: 20 * H })).toEqual({ from: 8, to: 9 });
    expect(logicalRangeFor([], { from: 0, to: 1 })).toBeNull();
  });
});

describe('mergeCandles', () => {
  it('une por tiempo sin duplicados y ordenado; las nuevas pisan a las existentes', () => {
    const cur = [{ time: 3, close: 1 }, { time: 4, close: 1 }];
    const merged = mergeCandles(cur, [{ time: 1 }, { time: 2 }, { time: 4, close: 9 }, { time: 5 }]);
    expect(merged.map((c) => c.time)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[3].close).toBe(9);
  });
  it('dos cargas de bordes que terminan en cualquier orden conservan ambas páginas', () => {
    const base = [{ time: 10 }, { time: 11 }];
    const older = [{ time: 8 }, { time: 9 }];
    const newer = [{ time: 12 }, { time: 13 }];
    const a = mergeCandles(mergeCandles(base, older), newer);
    const b = mergeCandles(mergeCandles(base, newer), older);
    expect(a.map((c) => c.time)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(b).toEqual(a);
  });
});
