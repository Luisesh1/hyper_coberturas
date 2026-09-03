import { describe, expect, it } from 'vitest';
import { buildAggregateSeries, buildPortfolio, deriveOrchestratorRow } from './portfolio';

const HOUR = 3_600_000;

function snapshot(capturedAt, totalUsd, totalNetPnlUsd, hedgeTracking = null) {
  return {
    capturedAt,
    totalUsd,
    walletUsd: 0,
    lpUsd: totalUsd,
    hlAccountUsd: 0,
    breakdown: {
      accounting: totalNetPnlUsd == null ? undefined : { totalNetPnlUsd },
      hedgeTracking,
    },
  };
}

const orch = (over = {}) => ({
  id: 1,
  name: 'ETH-1',
  token0Symbol: 'ETH',
  token1Symbol: 'USDC',
  initialTotalUsd: 1000,
  accounting: { totalNetPnlUsd: 50, capitalAdjustmentsUsd: 200 },
  ...over,
});

describe('deriveOrchestratorRow', () => {
  it('mide el PnL del rango como diferencia entre los extremos de la ventana', () => {
    const row = deriveOrchestratorRow(orch(), [
      snapshot(HOUR, 1100, 10),
      snapshot(2 * HOUR, 1180, 34),
    ]);
    expect(row.rangePnlUsd).toBe(24);
    expect(row.capitalUsd).toBe(1180);
  });

  it('deja el PnL del rango en hueco si un extremo no trae contabilidad', () => {
    // Los snapshots anteriores al alta de `accounting` no tienen baseline: sin
    // ella el acumulado de por vida NO es el PnL de la ventana.
    const row = deriveOrchestratorRow(orch(), [
      snapshot(HOUR, 1100, null),
      snapshot(2 * HOUR, 1180, 34),
    ]);
    expect(row.rangePnlUsd).toBeNull();
    expect(row.lifetimePnlUsd).toBe(50);
  });

  it('sin snapshots no rinde cero: no rinde nada', () => {
    const row = deriveOrchestratorRow(orch(), []);
    expect(row.capitalUsd).toBeNull();
    expect(row.rangePnlUsd).toBeNull();
    expect(row.distanceToLiqPct).toBeNull();
    expect(row.snapshotCount).toBe(0);
  });

  it('la base de costo suma los depositos posteriores al alta', () => {
    expect(deriveOrchestratorRow(orch(), []).basisUsd).toBe(1200);
  });

  it('toma el riesgo y el funding del ultimo snapshot', () => {
    const row = deriveOrchestratorRow(orch(), [
      snapshot(HOUR, 1100, 10, { hasHedge: true, distanceToLiqPct: 30, projectedDailyFundingUsd: 1 }),
      snapshot(2 * HOUR, 1180, 34, { hasHedge: true, distanceToLiqPct: 8.4, projectedDailyFundingUsd: -2 }),
    ]);
    expect(row.distanceToLiqPct).toBe(8.4);
    expect(row.projectedDailyFundingUsd).toBe(-2);
  });
});

describe('buildPortfolio', () => {
  const rows = [
    { capitalUsd: 100, lifetimePnlUsd: 10, rangePnlUsd: 4, basisUsd: 90, projectedDailyFundingUsd: 2, distanceToLiqPct: 22, orchestrator: orch() },
    { capitalUsd: 200, lifetimePnlUsd: -5, rangePnlUsd: -1, basisUsd: 210, projectedDailyFundingUsd: -1, distanceToLiqPct: 8.4, orchestrator: orch({ id: 2 }) },
    { capitalUsd: null, lifetimePnlUsd: null, rangePnlUsd: null, basisUsd: null, projectedDailyFundingUsd: null, distanceToLiqPct: null, orchestrator: orch({ id: 3 }) },
  ];

  it('suma solo lo medible y dice cuantas filas respaldan cada cifra', () => {
    const p = buildPortfolio(rows);
    expect(p.capitalUsd).toBe(300);
    expect(p.capitalFrom).toBe(2);
    expect(p.orchestrators).toBe(3);
    expect(p.lifetimePnlUsd).toBe(5);
    expect(p.rangePnlUsd).toBe(3);
  });

  it('separa quien cobra funding de quien lo paga', () => {
    const p = buildPortfolio(rows);
    expect(p.fundingPerDayUsd).toBe(1);
    expect(p.fundingEarning).toBe(1);
    expect(p.fundingPaying).toBe(1);
  });

  it('el peor margen es el minimo, con su orquestador', () => {
    const p = buildPortfolio(rows);
    expect(p.worstLiq.distanceToLiqPct).toBe(8.4);
    expect(p.worstLiq.orchestrator.id).toBe(2);
  });

  it('no calcula porcentaje si la base no cubre a los mismos que aportaron PnL', () => {
    const p = buildPortfolio([...rows, { capitalUsd: 10, lifetimePnlUsd: 1, rangePnlUsd: null, basisUsd: null, projectedDailyFundingUsd: null, distanceToLiqPct: null, orchestrator: orch({ id: 4 }) }]);
    expect(p.lifetimePnlPct).toBeNull();
  });

  it('calcula el porcentaje sobre la base de costo, no sobre el valor de mercado', () => {
    const p = buildPortfolio(rows);
    expect(p.lifetimePnlPct).toBeCloseTo((5 / 300) * 100, 10);
  });

  it('un portafolio vacio no inventa ceros', () => {
    const p = buildPortfolio([]);
    expect(p.capitalUsd).toBeNull();
    expect(p.lifetimePnlUsd).toBeNull();
    expect(p.worstLiq).toBeNull();
  });
});

describe('buildAggregateSeries', () => {
  it('arrastra cada serie hacia adelante pero nunca antes de su primer dato', () => {
    const curve = buildAggregateSeries([
      { snapshots: [snapshot(HOUR, 100, 0), snapshot(3 * HOUR, 120, 0)] },
      { snapshots: [snapshot(2 * HOUR, 50, 0)] },
    ]);
    expect(curve.map((p) => p.value)).toEqual([100, 150, 170]);
    // El segundo orquestador no existia en la primera hora: no aporta cero.
    expect(curve[0].contributors).toBe(1);
    expect(curve[2].contributors).toBe(2);
  });

  it('cuantiza a la hora para que snapshots casi simultaneos se sumen juntos', () => {
    const curve = buildAggregateSeries([
      { snapshots: [snapshot(HOUR + 12_000, 100, 0)] },
      { snapshots: [snapshot(HOUR + 48_000, 40, 0)] },
    ]);
    expect(curve).toHaveLength(1);
    expect(curve[0].value).toBe(140);
  });

  it('descarta puntos sin valor finito en vez de contarlos como cero', () => {
    const curve = buildAggregateSeries([
      { snapshots: [snapshot(HOUR, null, 0), snapshot(2 * HOUR, 80, 0)] },
    ]);
    expect(curve.map((p) => p.value)).toEqual([80]);
  });

  it('sin series devuelve una curva vacia', () => {
    expect(buildAggregateSeries([{ snapshots: [] }])).toEqual([]);
  });
});
