import { describe, expect, it } from 'vitest';
import { closedTradeRows, openPositionRows, pendingOrderRows, usageRows } from './botActivity';

const buyPos = { id: 1, mode: 'shadow', symbol: 'ETH-251031-2500-C', side: 'BUY', quantity: 0.01, entryPrice: 10, openedAt: 1 };

describe('openPositionRows', () => {
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
