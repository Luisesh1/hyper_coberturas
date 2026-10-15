import { describe, expect, it } from 'vitest';
import { buildKpis, buildLimits } from './strategyView';

// Forma real de GET /options/strategies/:id (Backend B): KPIs por libro.
const detail = {
  mode: 'live',
  limits: { maxMarginUsdt: 1000, maxDailyLossUsdt: 100, maxNetDelta: 1, maxOrdersPerDay: 10 },
  kpis: {
    shadow: { realizedPnlUsdt: 500, pnl30dUsdt: 412.8, feesUsdt: 3, premiumUsdt: 1052.5, cycles: 4, winRatePct: 75, openPositions: 2 },
    live: { realizedPnlUsdt: 188.1, pnl30dUsdt: 188.1, feesUsdt: 2, premiumUsdt: 1020, cycles: 2, winRatePct: 50, openPositions: 2 },
  },
  usage: { mode: 'live', marginUsedUsdt: 620, dailyLossUsdt: 0, ordersToday: 2, netDelta: -0.02 },
};

describe('buildKpis con KPIs por libro', () => {
  it('usa el P&L de 30 días de cada libro y los ciclos del libro activo', () => {
    const byLabel = Object.fromEntries(buildKpis(detail).map((k) => [k.label, k.value]));
    expect(byLabel['P&L sombra']).toContain('412,80');
    expect(byLabel['P&L real']).toContain('188,10');
    expect(byLabel['Prima cobrada']).toContain('1.020');
    expect(byLabel['Ciclos']).toBe('2');
    expect(byLabel['Margen en uso']).toContain('620');
    expect(Object.keys(byLabel)).not.toContain('Shadow');
  });

  it('en sombra toma ciclos y prima del libro sombra', () => {
    const byLabel = Object.fromEntries(buildKpis({ ...detail, mode: 'shadow' }).map((k) => [k.label, k.value]));
    expect(byLabel['Ciclos']).toBe('4');
    expect(byLabel['Prima cobrada']).toContain('1.052');
  });
});

describe('buildLimits con usage', () => {
  it('rellena las barras con el consumo del servidor', () => {
    const rows = Object.fromEntries(buildLimits(detail).map((r) => [r.key, r]));
    expect(rows.maxMarginUsdt.pct).toBeCloseTo(62);
    expect(rows.maxOrdersPerDay.value).toContain('2 / 10');
  });
});
