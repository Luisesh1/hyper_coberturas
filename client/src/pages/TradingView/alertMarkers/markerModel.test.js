import { describe, it, expect } from 'vitest';
import {
  ALERT_COLORS, MAX_ALERT_MARKERS, nextColor, addAlert, removeAlert, toggleAlertHidden,
  setAlertColor, chartBucketSec, buildMarkers, eventsInBucket,
  countFirings, alertRanges, replayCutoffMs, markerTimeline,
} from './markerModel.js';

const H = 3_600_000;
const T = (h, m = 0) => Date.UTC(2026, 0, 5, h, m);
const candles = (tfMs, from, n) => Array.from({ length: n }, (_, i) => ({ time: from + i * tfMs }));
const ev = (evalTime, suppressed = false) => ({ evalTime, time: evalTime, suppressed });
const alertsById = { a: { id: 'a', direction: 'bullish' }, b: { id: 'b', direction: 'bearish' }, n: { id: 'n', direction: 'neutral' } };

describe('chartBucketSec', () => {
  const c1h = candles(H, T(10), 12);
  it('un disparo 15m de las 14:15 cae en la vela 1h de las 14:00', () => {
    expect(chartBucketSec(T(14, 15), '1h', c1h)).toBe(T(14) / 1000);
  });
  it('un disparo de las 15:00 cae en la vela 1h de las 14:00', () => {
    expect(chartBucketSec(T(15), '1h', c1h)).toBe(T(14) / 1000);
  });
  it('en un gráfico 1m cae en la vela de las 14:14', () => {
    expect(chartBucketSec(T(14, 15), '1m', candles(60_000, T(13), 180))).toBe(T(14, 14) / 1000);
  });
  it('evalTime en un hueco de mercado cae en la última vela anterior', () => {
    const c = [...candles(H, T(10), 3), ...candles(H, T(20), 2)]; // 10,11,12 | 20,21
    expect(chartBucketSec(T(16), '1h', c)).toBe(T(12) / 1000);
  });
  it('temporalidad desconocida → null', () => {
    expect(chartBucketSec(T(14, 15), '7m', c1h)).toBeNull();
  });
  it('null antes de la primera vela o después del cierre de la última', () => {
    expect(chartBucketSec(T(10), '1h', c1h)).toBeNull();
    expect(chartBucketSec(T(22) + 1, '1h', c1h)).toBeNull();
    expect(chartBucketSec(T(22), '1h', c1h)).toBe(T(21) / 1000);
    expect(chartBucketSec(T(12), '1h', [])).toBeNull();
  });
});

describe('buildMarkers', () => {
  const c4h = candles(4 * H, T(0), 6);
  const base = { alertsById, chartTf: '4h', chartCandles: c4h };
  it('tres disparos en la misma vela 4h → una marca ×3', () => {
    const m = buildMarkers({ ...base, items: [{ alertId: 'a', color: '#facc15', hidden: false }],
      eventsByAlert: { a: [ev(T(5)), ev(T(6)), ev(T(7))] } });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ text: '×3', color: '#facc15', position: 'belowBar', shape: 'arrowUp', time: T(4) / 1000, id: `a:${T(4) / 1000}` });
  });
  it('bucket solo con suprimidos → color con alpha 0.35', () => {
    const m = buildMarkers({ ...base, items: [{ alertId: 'b', color: '#ffffff', hidden: false }],
      eventsByAlert: { b: [ev(T(5), true)] } });
    expect(m[0].color).toBe('rgba(255,255,255,0.35)');
    expect(m[0]).toMatchObject({ text: '', position: 'aboveBar', shape: 'arrowDown' });
  });
  it('neutral → círculo; mezcla suprimido/no suprimido conserva color', () => {
    const m = buildMarkers({ ...base, items: [{ alertId: 'n', color: '#ffffff', hidden: false }],
      eventsByAlert: { n: [ev(T(5), true), ev(T(6))] } });
    expect(m[0]).toMatchObject({ shape: 'circle', position: 'aboveBar', color: '#ffffff' });
  });
  it('hidden no genera marcas', () => {
    expect(buildMarkers({ ...base, items: [{ alertId: 'a', color: '#fff', hidden: true }],
      eventsByAlert: { a: [ev(T(5))] } })).toEqual([]);
  });
  it('cutoff de replay oculta los posteriores', () => {
    const m = buildMarkers({ ...base, cutoffMs: T(6), items: [{ alertId: 'a', color: '#fff', hidden: false }],
      eventsByAlert: { a: [ev(T(5)), ev(T(9))] } });
    expect(m).toHaveLength(1);
    expect(m[0].time).toBe(T(4) / 1000);
  });
  it('el cutoff usa evalTime, no time', () => {
    const e = { evalTime: T(15), time: T(14), suppressed: false };
    const m = buildMarkers({ ...base, cutoffMs: T(14, 30), items: [{ alertId: 'a', color: '#fff', hidden: false }],
      eventsByAlert: { a: [e] } });
    expect(m).toEqual([]);
  });
  it('ordena por time', () => {
    const m = buildMarkers({ ...base, items: [
      { alertId: 'a', color: '#fff', hidden: false }, { alertId: 'b', color: '#000', hidden: false }],
    eventsByAlert: { a: [ev(T(13))], b: [ev(T(5))] } });
    expect(m.map((x) => x.time)).toEqual([T(4) / 1000, T(12) / 1000]);
  });
});

describe('eventsInBucket', () => {
  it('devuelve los eventos de items visibles en la vela', () => {
    const c = candles(4 * H, T(0), 6);
    const items = [{ alertId: 'a', hidden: false }, { alertId: 'b', hidden: true }];
    const e1 = ev(T(5));
    const out = eventsInBucket({ a: [e1, ev(T(9))], b: [ev(T(5))] }, items, '4h', c, T(4) / 1000);
    expect(out).toEqual([{ alertId: 'a', event: e1 }]);
  });
});

describe('eventsInBucket cutoff', () => {
  it('no lista eventos posteriores al cutoff', () => {
    const c = candles(4 * H, T(0), 6);
    const items = [{ alertId: 'a', hidden: false }];
    const e1 = ev(T(5));
    const out = eventsInBucket({ a: [e1, ev(T(7))] }, items, '4h', c, T(4) / 1000, T(6));
    expect(out).toEqual([{ alertId: 'a', event: e1 }]);
  });
});

describe('items', () => {
  it('addAlert no pasa de 6 y asigna el primer color libre', () => {
    let items = [];
    for (let i = 0; i < 8; i++) items = addAlert(items, `x${i}`);
    expect(items).toHaveLength(MAX_ALERT_MARKERS);
    expect(items.map((i) => i.color)).toEqual(ALERT_COLORS);
    expect(addAlert(items, 'x0')).toBe(items);
    const freed = removeAlert(items, 'x1');
    expect(nextColor(freed)).toBe(ALERT_COLORS[1]);
    expect(addAlert(freed, 'new').find((i) => i.alertId === 'new').color).toBe(ALERT_COLORS[1]);
  });
  it('toggle y setColor son puros', () => {
    const items = addAlert([], 'a');
    const t = toggleAlertHidden(items, 'a');
    expect(t[0].hidden).toBe(true);
    expect(items[0].hidden).toBe(false);
    expect(setAlertColor(items, 'a', '#123456')[0].color).toBe('#123456');
  });
});

describe('countFirings', () => {
  it('cuenta solo los no suprimidos, respetando el cutoff', () => {
    const out = countFirings({ a: [ev(T(1)), ev(T(2), true), ev(T(3))], b: [] }, T(2));
    expect(out).toEqual({ a: 1, b: 0 });
    expect(countFirings({ a: [ev(T(1)), ev(T(3))] })).toEqual({ a: 2 });
    expect(countFirings(undefined)).toEqual({});
  });
});

describe('alertRanges', () => {
  it('de la primera vela al cierre de la última', () => {
    expect(alertRanges(candles(H, T(0), 3), '1h')).toEqual([{ fromMs: T(0), toMs: T(3) }]);
  });
  it('sin velas o TF desconocida → []', () => {
    expect(alertRanges([], '1h')).toEqual([]);
    expect(alertRanges(candles(H, T(0), 3), 'xx')).toEqual([]);
  });
});

describe('replayCutoffMs', () => {
  it('fuera de replay → Infinity', () => {
    expect(replayCutoffMs({ active: false, progress: { ltfTime: T(1) }, subTf: '1m', anchor: T(0) })).toBe(Infinity);
  });
  it('ltfTime + duración de la sub-TF', () => {
    expect(replayCutoffMs({ active: true, progress: { ltfTime: T(1) }, subTf: '15m', anchor: T(0) })).toBe(T(1, 15));
  });
  it('sin ltfTime usa el anchor', () => {
    expect(replayCutoffMs({ active: true, progress: { ltfTime: null }, subTf: '15m', anchor: T(0) })).toBe(T(0));
  });
});

describe('markerTimeline', () => {
  it('eventos visibles, con su vela, ordenados por evalTime', () => {
    const c = candles(4 * H, T(0), 6);
    const items = [{ alertId: 'a', hidden: false }, { alertId: 'b', hidden: false }, { alertId: 'h', hidden: true }];
    const a1 = ev(T(9)); const b1 = ev(T(5)); const late = ev(T(30));
    const out = markerTimeline({ a: [a1, ev(T(20))], b: [b1, late], h: [ev(T(6))] }, items, '4h', c, T(19));
    expect(out).toEqual([
      { alertId: 'b', event: b1, sec: T(4) / 1000 },
      { alertId: 'a', event: a1, sec: T(8) / 1000 },
    ]);
  });
});
