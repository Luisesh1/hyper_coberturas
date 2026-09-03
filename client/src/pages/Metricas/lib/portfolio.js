import { finite, toNumber } from './format';

/**
 * Reduce la serie de snapshots de un orquestador a la fila comparable de la
 * tabla. Todo lo que no se puede medir queda en `null` para que la UI pinte
 * un hueco: un orquestador sin snapshots no rinde cero, no rinde *nada*.
 */
export function deriveOrchestratorRow(orchestrator, series = []) {
  const snapshots = Array.isArray(series) ? series : [];
  const first = snapshots[0] || null;
  const last = snapshots[snapshots.length - 1] || null;
  const hedgeTracking = last?.breakdown?.hedgeTracking || null;

  // El PnL de la ventana es la diferencia entre dos contabilidades congeladas.
  // Los snapshots anteriores al alta de `accounting` no traen baseline: en ese
  // caso no hay PnL de rango, y decirlo es mejor que inventar el acumulado.
  const openPnlUsd = finite(first?.breakdown?.accounting?.totalNetPnlUsd);
  const closePnlUsd = finite(last?.breakdown?.accounting?.totalNetPnlUsd);

  return {
    id: orchestrator.id,
    orchestrator,
    capturedAt: finite(last?.capturedAt),
    capitalUsd: finite(last?.totalUsd),
    rangePnlUsd: openPnlUsd != null && closePnlUsd != null ? closePnlUsd - openPnlUsd : null,
    // Fuente de verdad del acumulado: la contabilidad viva del orquestador,
    // que el poll de la pagina refresca sin depender del proximo snapshot.
    lifetimePnlUsd: finite(orchestrator.accounting?.totalNetPnlUsd),
    // Base de costo real = capital inicial + depositos − retiros. Sin esto el
    // porcentaje se calcularia contra un valor de mercado que ya incluye el
    // propio PnL y los depositos posteriores.
    basisUsd: basisOf(orchestrator),
    hasHedge: Boolean(hedgeTracking?.hasHedge),
    distanceToLiqPct: finite(hedgeTracking?.distanceToLiqPct),
    projectedDailyFundingUsd: finite(hedgeTracking?.projectedDailyFundingUsd),
    fundingHeadwind: hedgeTracking?.fundingHeadwind === true,
    timeInRangePct: finite(hedgeTracking?.timeInRangePct),
    sparkline: snapshots.map((s) => finite(s.totalUsd)).filter((v) => v != null),
    snapshotCount: snapshots.length,
    // La serie completa viaja con la fila: la tarjeta expandida la consume tal
    // cual en vez de volver a pedirla al abrirse.
    snapshots,
  };
}

function basisOf(orchestrator) {
  const initial = finite(orchestrator.initialTotalUsd);
  if (initial == null) return null;
  return initial + (finite(orchestrator.accounting?.capitalAdjustmentsUsd) || 0);
}

/**
 * Agregado de portafolio sobre las filas visibles. Cada suma lleva cuántas
 * filas la respaldan: si dos de cinco orquestadores no reportan capital, la
 * cifra sigue siendo cierta pero parcial, y la UI tiene que poder decirlo.
 */
export function buildPortfolio(rows) {
  const totals = {
    orchestrators: rows.length,
    capitalUsd: 0, capitalFrom: 0,
    lifetimePnlUsd: 0, lifetimePnlFrom: 0,
    rangePnlUsd: 0, rangePnlFrom: 0,
    basisUsd: 0, basisFrom: 0,
    fundingPerDayUsd: 0, fundingFrom: 0,
    fundingEarning: 0, fundingPaying: 0,
    worstLiq: null,
  };

  for (const row of rows) {
    if (row.capitalUsd != null) { totals.capitalUsd += row.capitalUsd; totals.capitalFrom += 1; }
    if (row.lifetimePnlUsd != null) { totals.lifetimePnlUsd += row.lifetimePnlUsd; totals.lifetimePnlFrom += 1; }
    if (row.rangePnlUsd != null) { totals.rangePnlUsd += row.rangePnlUsd; totals.rangePnlFrom += 1; }
    if (row.basisUsd != null) { totals.basisUsd += row.basisUsd; totals.basisFrom += 1; }
    if (row.projectedDailyFundingUsd != null) {
      totals.fundingPerDayUsd += row.projectedDailyFundingUsd;
      totals.fundingFrom += 1;
      if (row.projectedDailyFundingUsd >= 0) totals.fundingEarning += 1;
      else totals.fundingPaying += 1;
    }
    if (row.distanceToLiqPct != null
      && (totals.worstLiq == null || row.distanceToLiqPct < totals.worstLiq.distanceToLiqPct)) {
      totals.worstLiq = row;
    }
  }

  return {
    ...totals,
    capitalUsd: totals.capitalFrom ? totals.capitalUsd : null,
    lifetimePnlUsd: totals.lifetimePnlFrom ? totals.lifetimePnlUsd : null,
    rangePnlUsd: totals.rangePnlFrom ? totals.rangePnlUsd : null,
    fundingPerDayUsd: totals.fundingFrom ? totals.fundingPerDayUsd : null,
    // Solo tiene sentido como porcentaje si la base cubre a todos los que
    // aportaron PnL; si no, es un cociente entre dos poblaciones distintas.
    lifetimePnlPct: totals.basisFrom === totals.lifetimePnlFrom && totals.basisUsd > 0
      ? (totals.lifetimePnlUsd / totals.basisUsd) * 100
      : null,
  };
}

const HOUR_MS = 3_600_000;

/**
 * Curva agregada del portafolio. Los snapshots son horarios pero no llegan
 * exactamente al mismo milisegundo, así que se cuantizan a la hora y cada
 * serie se arrastra hacia adelante desde su primer dato — nunca desde antes:
 * un orquestador que no existía no aporta cero, no aporta nada.
 */
export function buildAggregateSeries(rows) {
  const series = [];
  for (const row of rows) {
    const byHour = new Map();
    for (const snapshot of row.snapshots || []) {
      const t = toNumber(snapshot.capturedAt);
      const v = toNumber(snapshot.totalUsd);
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      byHour.set(Math.floor(t / HOUR_MS) * HOUR_MS, v);
    }
    if (byHour.size) series.push(byHour);
  }
  if (!series.length) return [];

  const stamps = [...new Set(series.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
  const held = new Array(series.length).fill(null);
  const out = [];
  for (const t of stamps) {
    let total = 0;
    let contributors = 0;
    for (let i = 0; i < series.length; i += 1) {
      const value = series[i].get(t);
      if (value != null) held[i] = value;
      if (held[i] != null) { total += held[i]; contributors += 1; }
    }
    out.push({ t, value: total, contributors });
  }
  return out;
}
