import { describe, expect, it } from 'vitest';
import {
  botDirections, buildBotKpis, buildBotPayload, buildMapping, filterSignals, initialBotForm,
  latestSignal, normalizeBot, normalizeSignals, signalStats, validateBotForm, withStructure,
} from './botView';

describe('buildMapping', () => {
  it('comprar a favor: alcista → call, bajista → put', () => {
    const rows = buildMapping('buy_with', { targetDelta: 0.35, expiryDays: 7 });
    expect(rows.map((r) => [r.direction, r.action, r.detail])).toEqual([
      ['bullish', 'Comprar call', 'Δ ≈ 0,35 · venc. ~7 d'],
      ['bearish', 'Comprar put', 'Δ ≈ −0,35 · venc. ~7 d'],
    ]);
  });

  it('vender en contra: alcista → vende put, bajista → vende call', () => {
    const rows = buildMapping('sell_against', { targetDelta: 0.25, expiryDays: 14 });
    expect(rows.map((r) => [r.direction, r.action, r.detail])).toEqual([
      ['bullish', 'Vender put', 'Δ ≈ −0,25 · venc. ~14 d'],
      ['bearish', 'Vender call', 'Δ ≈ 0,25 · venc. ~14 d'],
    ]);
  });
});

describe('formulario de bot', () => {
  it('valores por defecto según la estructura', () => {
    const f = initialBotForm({ underlying: 'ETH' });
    expect(f).toMatchObject({ underlying: 'ETH', structure: 'buy_with', targetDelta: 0.35, takeProfitPct: 80, stopLossPct: 50, maxPremiumUsdt: 150, expiryDays: 7, onOpposite: 'reverse', exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4 });
    const s = withStructure(f, 'sell_against');
    expect(s).toMatchObject({ structure: 'sell_against', targetDelta: 0.25, takeProfitPct: 50, stopLossPct: 200, maxPremiumUsdt: null, maxMarginUsdt: 1000 });
  });

  it('valida nombre, alertas y rangos', () => {
    const errors = validateBotForm({ ...initialBotForm(), name: ' ', alertIds: [], targetDelta: 2, maxOpenPositions: 1.5 });
    expect(errors).toEqual({
      name: 'Ponle un nombre',
      alertIds: 'Elige al menos una alerta',
      targetDelta: 'Máximo 0,95',
      maxOpenPositions: 'Debe ser un número entero',
    });
  });

  it('payload: prima máx. sólo al comprar; margen en limits al vender; sin subyacente al editar', () => {
    const buy = buildBotPayload({ ...initialBotForm({ underlying: 'BTC' }), name: ' Bot ', alertIds: [3] });
    expect(buy).toEqual({
      name: 'Bot',
      underlying: 'BTC',
      alertIds: [3],
      params: {
        structure: 'buy_with', targetDelta: 0.35, expiryDays: 7, quantity: 0.01, onOpposite: 'reverse',
        takeProfitPct: 80, stopLossPct: 50, exitHoursBeforeExpiry: 12, maxOpenPositions: 1, maxTradesPerDay: 4,
        maxPremiumUsdt: 150, contractCount: 1, capitalUsdt: null,
      },
      limits: {},
    });
    const sell = buildBotPayload({ ...withStructure(initialBotForm(), 'sell_against'), name: 'S', alertIds: [1] }, { editing: true, baseLimits: { maxDailyLossUsdt: 50 } });
    expect(sell.underlying).toBeUndefined();
    expect(sell.params.maxPremiumUsdt).toBeUndefined();
    expect(sell.limits).toEqual({ maxDailyLossUsdt: 50, maxMarginUsdt: 1000 });
  });

  it('al editar parte de los parámetros guardados', () => {
    const bot = normalizeBot({
      id: 1, name: 'X', underlying: 'SOL', mode: 'live',
      params: { alertIds: [4, 5], structure: 'sell_against', targetDelta: -0.3, quantity: 2, onOpposite: 'close' },
      limits: { maxMarginUsdt: 500 },
    });
    expect(initialBotForm({ bot })).toMatchObject({
      name: 'X', underlying: 'SOL', alertIds: [4, 5], structure: 'sell_against', targetDelta: 0.3, quantity: 2, onOpposite: 'close', takeProfitPct: 50, maxMarginUsdt: 500,
    });
  });
});

describe('señales y KPIs', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const raw = [
    { id: 1, alertName: 'A', direction: 'bullish', score: 85, decision: 'opened', createdAt: now - 1000 },
    { id: 2, alertName: 'B', direction: 'bearish', score: 72, decision: 'ignored', detail: 'Máx. 1', createdAt: now - 5000 },
    { id: 3, alertName: 'B', direction: 'bearish', score: 70, decision: 'closed', createdAt: now - 3000 },
    { id: 4, alertName: 'B', direction: 'bearish', score: 70, decision: 'error', createdAt: now - 40 * 86400000 },
  ];

  it('ordena por fecha y filtra operadas / ignoradas', () => {
    const list = normalizeSignals(raw);
    expect(list.map((s) => s.id)).toEqual([1, 3, 2, 4]);
    expect(filterSignals(list, 'traded').map((s) => s.decisionLabel)).toEqual(['Abrió', 'Cerró']);
    expect(filterSignals(list, 'ignored').map((s) => s.decisionLabel)).toEqual(['Ignorada', 'Error']);
  });

  it('KPIs: señales de 30 días por dirección, operadas, P&L por libro y acierto', () => {
    const stats = signalStats(normalizeSignals(raw), now);
    expect(stats).toEqual({ total: 3, bullish: 1, bearish: 2, traded: 2 });
    const kpis = buildBotKpis({ mode: 'shadow', kpis: { shadow: { pnl30dUsdt: 214.6, cycles: 9, winRatePct: 66.67 }, live: { pnl30dUsdt: -5 } } }, stats);
    expect(kpis.map((k) => [k.label, k.value, k.hint])).toEqual([
      ['Señales 30d', '3', '1 alcistas · 2 bajistas'],
      ['Operadas', '2', 'el resto, ignoradas por reglas'],
      ['P&L sombra', '+214,60', 'USDT · 30 días'],
      ['P&L real', '−5,00', 'USDT · 30 días'],
      ['Acierto', '6 / 9', 'operaciones ganadoras'],
    ]);
  });

  it('direcciones del bot y última señal entre bots', () => {
    expect(botDirections([{ direction: 'bearish' }, { direction: 'bullish' }, { direction: 'bullish' }])).toEqual(['bullish', 'bearish']);
    const bots = [
      normalizeBot({ id: 1, lastSignal: { direction: 'bearish', decision: 'ignored', createdAt: 10 } }),
      normalizeBot({ id: 2, lastSignal: { direction: 'bullish', decision: 'opened', createdAt: 20 } }),
      normalizeBot({ id: 3 }),
    ];
    expect(latestSignal(bots).bot.id).toBe(2);
  });
});
