import { describe, expect, it } from 'vitest';
import { pendingEntryRows, closedTradeRows, formatElapsed, openPositionRows, pendingOrderRows, usageRows } from './botActivity';

const buyPos = { id: 1, mode: 'shadow', symbol: 'ETH-251031-2500-C', side: 'BUY', quantity: 0.01, entryPrice: 10, openedAt: 1 };

describe('openPositionRows', () => {
  it('tpPct: incremento del TP sobre la entrada (negativo al vender)', () => {
    const [buy] = openPositionRows({ positions: [buyPos], params: { takeProfitPct: 80, stopLossPct: 50 } }, 'shadow');
    expect(buy.tpPct).toBeCloseTo(80);
    const [sell] = openPositionRows({ positions: [{ ...buyPos, side: 'SELL' }], params: { takeProfitPct: 50, stopLossPct: 200 } }, 'shadow');
    expect(sell.tpPct).toBeCloseTo(-50);
    const [none] = openPositionRows({ positions: [buyPos], params: {} }, 'shadow');
    expect(none.tpPct).toBeNull();
  });
  it('prima total = entrada × cantidad y hora de apertura', () => {
    const [r] = openPositionRows({ positions: [{ ...buyPos, openedAt: 1761141900000 }], params: {} }, 'shadow');
    expect(r.premiumUsdt).toBeCloseTo(0.1);
    expect(r.openedAt).toBe(1761141900000);
    const [none] = openPositionRows({ positions: [{ ...buyPos, entryPrice: null }], params: {} }, 'shadow');
    expect(none.premiumUsdt).toBeNull();
  });
  it('compra: TP y stop sobre la entrada', () => {
    const [r] = openPositionRows({ positions: [{ ...buyPos, mark: 12 }], params: { takeProfitPct: 80, stopLossPct: 50 } }, 'shadow');
    expect(r.tpPrice).toBe(18);
    expect(r.stopPrice).toBe(5);
    expect(r.pnlUsdt).toBeCloseTo(0.02);
    expect(r.pnlPct).toBeCloseTo(20);
    expect(r.tone).toBe('pos');
    expect(r.sideLabel).toBe('Comprar');
  });
  it('venta: recompra y stop invertidos', () => {
    const [r] = openPositionRows({ positions: [{ ...buyPos, side: 'SELL', mark: 12 }], params: { takeProfitPct: 50, stopLossPct: 200 } }, 'shadow');
    expect(r.tpPrice).toBe(5);
    expect(r.stopPrice).toBe(30);
    expect(r.tone).toBe('neg');
  });
  it('volatility usa takeProfitTarget.price o null', () => {
    const d = (extra) => ({ positions: [{ ...buyPos, ...extra }], params: { takeProfitMode: 'volatility', takeProfitPct: 80, stopLossPct: 50 } });
    expect(openPositionRows(d({ takeProfitTarget: { price: 15 } }), 'shadow')[0].tpPrice).toBe(15);
    expect(openPositionRows(d({}), 'shadow')[0].tpPrice).toBeNull();
  });
  it('atr_band: tp = tpTargetPrice, sin stop, con desglose', () => {
    const meta = { spot: 3000, interval: '1h', length: 14, multiplier: 2, bandValue: 3060, distancePct: 2, leverage: 75, rawGainPct: 150, appliedGainPct: 150, capped: false };
    const d = (extra) => ({ positions: [{ ...buyPos, ...extra }], params: { takeProfitMode: 'atr_band', stopLossPct: 50 } });
    const [r] = openPositionRows(d({ tpTargetPrice: 25, tpTargetMeta: meta }), 'shadow');
    expect(r.tpPrice).toBe(25);
    expect(r.stopPrice).toBeNull();
    expect(r.tpBreakdown).toBe('Spot 3.000 → banda 3.060 (+2,0 %) × apal. 75× = +150 % → venta a 25,0 USDT');
    expect(openPositionRows(d({ tpTargetPrice: 25, tpTargetMeta: { ...meta, capped: true } }), 'shadow')[0].tpBreakdown).toMatch(/\(tope\)$/);
    const [pending] = openPositionRows(d({ tpTargetPrice: null, tpTargetMeta: null }), 'shadow');
    expect(pending.tpPrice).toBeNull();
    expect(pending.tpBreakdown).toBe('Calculando objetivo…');
  });
  it('filtra por modo y sin mark deja P&L nulo', () => {
    const rows = openPositionRows({ positions: [buyPos, { ...buyPos, id: 2, mode: 'live' }], params: {} }, 'live');
    expect(rows.map((r) => r.id)).toEqual([2]);
    expect(rows[0].pnlUsdt).toBeNull();
    expect(rows[0].tone).toBe('neutral');
  });
  it('horas al vencimiento desde el símbolo (08:00 UTC)', () => {
    const now = Date.UTC(2025, 9, 30, 8, 0);
    const [r] = openPositionRows({ positions: [{ ...buyPos, symbol: 'ETH-251031-2500-C' }], params: {} }, 'shadow', now);
    expect(r.hoursToExpiry).toBe(24);
  });
});

describe('pendingOrderRows', () => {
  const now = 1_000_000;
  it('TP residente en attention pide atención', () => {
    const [r] = pendingOrderRows({ pendingOrders: [{ id: 1, purpose: 'take_profit', action: 'close', symbol: 'X-C', side: 'SELL', price: 5, quantity: 0.01, executedQty: 0.005, status: 'attention', deadlineAt: now + 600000 }] }, now);
    expect(r.kindLabel).toBe('TP residente');
    expect(r.needsAttention).toBe(true);
    expect(r.filled).toBe('0,005 / 0,01');
    expect(r.expiresIn).toBe('10 min');
  });
  it('etiquetas de entrada y salida', () => {
    const rows = pendingOrderRows({ pendingOrders: [
      { id: 1, purpose: 'standard', action: 'open', status: 'queued', quantity: 1, executedQty: 0 },
      { id: 2, purpose: 'standard', action: 'close', status: 'submitted', quantity: 1, executedQty: 0 },
    ] }, now);
    expect(rows.map((r) => r.kindLabel)).toEqual(['Entrada', 'Salida']);
    expect(rows[0].needsAttention).toBe(false);
  });
});

describe('usageRows', () => {
  const bot = {
    mode: 'shadow',
    positions: [buyPos],
    usage: { ordersToday: 2, marginUsedUsdt: 50, dailyLossUsdt: 0 },
    params: { maxOpenPositions: 1, maxTradesPerDay: 4 },
    limits: { maxMarginUsdt: 200, maxDailyLossUsdt: null },
  };
  it('calcula porcentajes', () => {
    const rows = usageRows(bot);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ used: 1, max: 1, pct: 100 });
    expect(rows[1]).toMatchObject({ used: 2, max: 4, pct: 50 });
    expect(rows[2]).toMatchObject({ used: 50, max: 200, pct: 25 });
    expect(rows[3]).toMatchObject({ max: null, pct: null });
  });
  it('con presupuesto añade «Comprometido X de Y USDT»', () => {
    const rows = usageRows({ ...bot, params: { ...bot.params, budgetUsdt: 48 }, usage: { ...bot.usage, committedUsdt: 12 } });
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ label: 'Comprometido', used: 12, max: 48, pct: 25, text: '12 de 48 USDT' });
    expect(usageRows(bot).some((r) => r.label === 'Comprometido')).toBe(false);
  });
  it('no muestra fila de delta neto (null en bots con varios subyacentes)', () => {
    const rows = usageRows({ ...bot, usage: { ...bot.usage, netDelta: null } });
    expect(rows.some((r) => /delta|Δ/i.test(r.label))).toBe(false);
  });
});

describe('closedTradeRows', () => {
  it('motivo conocido, desconocido y filtro de modo', () => {
    const closed = [
      { id: 1, mode: 'shadow', symbol: 'A', entryPrice: 1, exitPrice: 2, openedAt: 1, closedAt: 2, pnlUsdt: 1, closeReason: 'stop_loss' },
      { id: 2, mode: 'shadow', symbol: 'A', closeReason: 'foo' },
      { id: 3, mode: 'live', symbol: 'A', closeReason: 'manual' },
    ];
    const rows = closedTradeRows({ closedPositions: closed }, 'shadow');
    expect(rows.map((r) => r.reasonLabel)).toEqual(['Stop', '—']);
  });
});

describe('pendingEntryRows', () => {
  const now = 1_800_000_000_000;
  it('fila con cuenta atrás, ejecutado, escalera y comisión estimada', () => {
    const [r] = pendingEntryRows({ pendingEntries: [{ id: 'a', mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.35, executedQty: 0, limitPrice: 712, deadlineAt: now + 372_000, bid: 700, ask: 725, feesEstUsdt: 7.14 }] }, now);
    expect(r.sideLabel).toBe('Comprar');
    expect(r.countdown).toBe('6:12');
    expect(r.progress).toBeCloseTo(0.62);
    expect(r.filled).toBe('0 de 0,35');
    expect(r.ladder.savingPerContract).toBe(13);
    expect(r.feeText).toBe('Comisión est. 7,14 USDT');
  });
  it('sin pendientes → []', () => {
    expect(pendingEntryRows({}, now)).toEqual([]);
  });
});

describe('comisiones por fila', () => {
  it('cerradas suman entrada + salida + ejercicio', () => {
    const [r] = closedTradeRows({ closedPositions: [{ id: 1, mode: 'shadow', entryFeeUsdt: 1, exitFeeUsdt: 2, exerciseFeeUsdt: null }] }, 'shadow');
    expect(r.feesUsdt).toBe(3);
    const [n] = closedTradeRows({ closedPositions: [{ id: 2, mode: 'shadow' }] }, 'shadow');
    expect(n.feesUsdt).toBeNull();
  });
  it('abiertas exponen feesUsdt', () => {
    const [r] = openPositionRows({ positions: [{ ...buyPos, entryFeeUsdt: 0.5 }], params: {} }, 'shadow');
    expect(r.feesUsdt).toBe(0.5);
  });
});

describe('formatElapsed', () => {
  it('minutos, horas y días desde la compra', () => {
    const MIN = 60_000;
    expect(formatElapsed(20_000)).toBe('< 1 min');
    expect(formatElapsed(45 * MIN)).toBe('45 min');
    expect(formatElapsed(60 * MIN)).toBe('1 h');
    expect(formatElapsed(135 * MIN)).toBe('2 h 15 min');
    expect(formatElapsed(28 * 60 * MIN)).toBe('1 día 4 h');
    expect(formatElapsed(3 * 24 * 60 * MIN)).toBe('3 días');
    expect(formatElapsed(null)).toBe('—');
    expect(formatElapsed(-1)).toBe('—');
  });
});

describe('closedTradeRows · rango de la prima', () => {
  const OPEN = Date.UTC(2026, 9, 28, 4, 1);
  const MIN = 60_000;
  const base = { id: 1, mode: 'shadow', symbol: 'BTC-261030-81500-P', side: 'BUY', entryPrice: 765, exitPrice: 1025, openedAt: OPEN, closedAt: OPEN + 71 * MIN };

  it('máximo y mínimo con variación sobre la entrada y tiempo desde la apertura', () => {
    const [r] = closedTradeRows({ closedPositions: [{ ...base, premiumRange: {
      high: { price: 1025, at: OPEN + 71 * MIN }, low: { price: 612, at: OPEN + 12 * MIN }, partial: false,
    } }] }, 'shadow');
    expect(r.premium.high).toMatchObject({ price: 1025, afterMs: 71 * MIN, afterText: '1 h 11 min', tone: 'pos' });
    expect(r.premium.high.changePct).toBeCloseTo(33.99, 1);
    expect(r.premium.low).toMatchObject({ price: 612, afterText: '12 min', tone: 'neg' });
    expect(r.premium.low.changePct).toBeCloseTo(-20);
    expect(r.premium).toMatchObject({ partial: false, sell: false });
  });

  it('al vender una prima más alta es pérdida; sin registro es null', () => {
    const [sell, none] = closedTradeRows({ closedPositions: [
      { ...base, side: 'SELL', premiumRange: { high: { price: 900, at: OPEN }, low: { price: 500, at: OPEN + MIN }, partial: true } },
      { ...base, id: 2, premiumRange: null },
    ] }, 'shadow');
    expect(sell.premium.high.tone).toBe('neg');
    expect(sell.premium.low.tone).toBe('pos');
    expect(sell.premium).toMatchObject({ partial: true, sell: true });
    expect(none.premium).toBeNull();
  });
});

describe('closedTradeRows · objetivo de TP', () => {
  const meta = { spot: 2400, bandValue: 2350, distancePct: -2.1, leverage: 12, appliedGainPct: 25, capped: false };
  const range = (high, low) => ({ high: { price: high, at: 2 }, low: { price: low, at: 3 }, partial: false });

  it('banda ATR: objetivo guardado, % sobre la entrada, desglose y si se alcanzó', () => {
    const detail = { params: { takeProfitMode: 'atr_band' }, closedPositions: [
      { id: 1, mode: 'shadow', side: 'BUY', entryPrice: 10, tpTargetPrice: 12.5, tpTargetMeta: meta, openedAt: 1, premiumRange: range(12.5, 9) },
      { id: 2, mode: 'shadow', side: 'BUY', entryPrice: 10, tpTargetPrice: 12.5, tpTargetMeta: meta, openedAt: 1, premiumRange: range(11, 4) },
      { id: 3, mode: 'shadow', side: 'BUY', entryPrice: 10, tpTargetPrice: 12.5, tpTargetMeta: meta, openedAt: 1, premiumRange: null },
    ] };
    const [hit, miss, unknown] = closedTradeRows(detail, 'shadow');
    expect(hit.target).toMatchObject({ price: 12.5, pct: 25, fromParams: false, reached: true });
    expect(hit.target.breakdown).toMatch(/^Spot 2\.400 → banda 2\.350/);
    expect(miss.target.reached).toBe(false);
    expect(unknown.target.reached).toBeNull();
  });

  it('porcentaje: se deriva de la configuración actual; al vender, alcanzado si la prima bajó al objetivo', () => {
    const detail = { params: { takeProfitPct: 50 }, closedPositions: [
      { id: 1, mode: 'shadow', side: 'SELL', entryPrice: 10, openedAt: 1, premiumRange: range(11, 4) },
    ] };
    const [r] = closedTradeRows(detail, 'shadow');
    expect(r.target).toMatchObject({ price: 5, pct: -50, fromParams: true, reached: true, breakdown: null });
  });

  it('sin objetivo conocido (volatilidad o banda sin fijar) → null', () => {
    const vol = closedTradeRows({ params: { takeProfitMode: 'volatility', takeProfitPct: 50 }, closedPositions: [{ id: 1, mode: 'shadow', entryPrice: 10 }] }, 'shadow');
    const band = closedTradeRows({ params: { takeProfitMode: 'atr_band' }, closedPositions: [{ id: 1, mode: 'shadow', entryPrice: 10 }] }, 'shadow');
    expect(vol[0].target).toBeNull();
    expect(band[0].target).toBeNull();
  });
});
