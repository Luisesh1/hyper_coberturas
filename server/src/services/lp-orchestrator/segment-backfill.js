/**
 * segment-backfill.js
 *
 * Reconstruccion (pura) de los tramos historicos de un orquestador a partir
 * de su action log y del log de rebalanceos de cobertura. Todo lo que el log
 * no explica (filas podadas, P&L del hedge) va a una linea de diferencia, nunca
 * se inventa: la suma de tramos no cambia respecto al historico sembrado.
 */

const { recomputeNetPnl, normalizeAccounting } = require('./accounting');
const {
  SEGMENT_OPENING_ACTIONS,
  SEGMENT_CLOSING_ACTIONS,
  classifyCloseReason,
  summarizeCoverage,
} = require('./segments');

const DIFFERENCE_LABEL = 'Diferencia de reconstrucción';
// Evita que el ruido de coma flotante cambie el resultado entre ejecuciones.
const PRECISION = 1e9;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value) {
  return Math.round(value * PRECISION) / PRECISION;
}

function hashesOf(row) {
  return Array.isArray(row.txHashes) ? row.txHashes.map(String) : [];
}

/**
 * Convierte el log en cortes ordenados: `open` (empieza un LP, cortando el
 * anterior si lo hay) o `close` (termina el LP vivo). Ignora lo posterior al
 * despliegue y los finalize repetidos (mismos hashes).
 */
function buildCuts(actionLog, deployAt) {
  const rows = (Array.isArray(actionLog) ? actionLog : [])
    .filter((r) => Number.isFinite(Number(r.createdAt)) && Number(r.createdAt) < deployAt)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));

  const seen = new Set();
  const cuts = [];
  for (const row of rows) {
    if (row.kind === 'attach_lp') {
      cuts.push({ type: 'open', at: row.createdAt, reason: 'attach', row });
    } else if (row.kind === 'kill_lp') {
      // El kill que se redirige a collect-fees no cierra el LP.
      if (row.action === 'collect-fees') continue;
      cuts.push({ type: 'close', at: row.createdAt, reason: 'lp_closed', row });
    } else if (row.kind === 'tx_finalized') {
      const hashes = hashesOf(row);
      if (hashes.length && hashes.every((h) => seen.has(h))) continue;
      hashes.forEach((h) => seen.add(h));
      if (SEGMENT_OPENING_ACTIONS.has(row.action)) {
        cuts.push({ type: 'open', at: row.createdAt, reason: openReasonOf(row.action), row });
      } else if (SEGMENT_CLOSING_ACTIONS.has(row.action)) {
        cuts.push({ type: 'close', at: row.createdAt, reason: 'lp_closed', row });
      }
    }
  }
  return cuts;
}

function openReasonOf(action) {
  return action === 'modify-range' || action === 'rebalance' ? 'rerange' : 'capital_change';
}

function sumDecisions(actionLog, from, to) {
  let lpFeesUsd = 0;
  let priceDriftUsd = 0;
  for (const row of actionLog) {
    if (row.kind !== 'decision') continue;
    if (!(row.createdAt >= from && row.createdAt < to)) continue;
    lpFeesUsd += num(row.accountingDelta?.lpFeesDelta);
    priceDriftUsd += num(row.accountingDelta?.priceDriftDelta);
  }
  return { lpFeesUsd, priceDriftUsd };
}

function makeSegment({ actionLog, rebalances, start, end, closeCut, deployAt }) {
  const { lpFeesUsd, priceDriftUsd } = sumDecisions(actionLog, start.at, end);
  const opener = start.row?.kind === 'tx_finalized' ? start.row.accountingDelta : null;
  const closer = closeCut?.row?.kind === 'tx_finalized' ? closeCut.row.accountingDelta : null;
  // Gas y slippage del ajuste son del tramo que abre; el cierre sin LP nuevo
  // no tiene tramo posterior, asi que queda en el viejo. Las fees cobradas en
  // el ajuste son del viejo.
  const closeOnly = closeCut && closeCut.type === 'close';
  const accounting = recomputeNetPnl({
    lpFeesUsd: lpFeesUsd + num(closer?.collectedFeesUsd),
    priceDriftUsd,
    gasSpentUsd: num(opener?.gasCostUsd) + (closeOnly ? num(closer?.gasCostUsd) : 0),
    swapSlippageUsd: num(opener?.slippageCostUsd) + (closeOnly ? num(closer?.slippageCostUsd) : 0),
  });
  let closeReason = 'unknown';
  if (closeCut) {
    closeReason = closeCut.type === 'close'
      ? 'lp_closed'
      : classifyCloseReason({ action: closeCut.row.action });
    if (closeCut.type === 'open' && closeCut.row.kind === 'attach_lp') closeReason = 'unknown';
  }
  const inInterval = (Array.isArray(rebalances) ? rebalances : [])
    .filter((r) => Number(r.createdAt) >= start.at && Number(r.createdAt) < end);
  return {
    accuracy: 'approximate',
    openReason: 'backfill',
    openedAt: start.at,
    closedAt: end,
    closeReason,
    openTxHashes: start.row ? hashesOf(start.row) : null,
    closeTxHashes: closeCut ? hashesOf(closeCut.row) : null,
    accounting,
    baselineAccounting: {},
    coverage: summarizeCoverage(inInterval, { openedAt: start.at, closedAt: end }),
    deployAt,
  };
}

/**
 * @param {object} input
 * @param {object} input.orchestrator
 * @param {object[]} input.actionLog      filas mapeadas (kind, action, createdAt, accountingDelta, txHashes)
 * @param {object[]} input.rebalances     filas del log de cobertura (createdAt, actualQtyAfter, targetQtyAfter)
 * @param {object} input.historicalSegment  { openedAt, closedAt, accounting } (tramo sembrado o suma de backfill)
 * @returns {{ segments: object[], differenceUsd: number }}
 */
function buildHistoricalSegments({ actionLog = [], rebalances = [], historicalSegment } = {}) {
  const deployAt = Number(historicalSegment?.closedAt);
  if (!Number.isFinite(deployAt)) throw new Error('historicalSegment.closedAt requerido');
  const total = normalizeAccounting(historicalSegment.accounting).totalNetPnlUsd;

  const cuts = buildCuts(actionLog, deployAt);
  const log = Array.isArray(actionLog) ? actionLog : [];
  const segments = [];
  let current = null; // { at, row }
  for (const cut of cuts) {
    if (current) {
      segments.push(makeSegment({
        actionLog: log, rebalances, start: current, end: cut.at, closeCut: cut, deployAt,
      }));
      current = null;
    }
    if (cut.type === 'open') current = { at: cut.at, row: cut.row };
  }
  if (current) {
    segments.push(makeSegment({
      actionLog: log, rebalances, start: current, end: deployAt, closeCut: null, deployAt,
    }));
  }
  segments.forEach((s) => { delete s.deployAt; });

  const explained = segments.reduce((acc, s) => acc + s.accounting.totalNetPnlUsd, 0);
  const differenceUsd = round(total - explained);
  const startAt = Number.isFinite(Number(historicalSegment.openedAt))
    ? Number(historicalSegment.openedAt)
    : (segments[0]?.openedAt ?? deployAt);
  segments.push({
    accuracy: 'approximate',
    openReason: 'backfill',
    closeReason: 'unknown',
    label: DIFFERENCE_LABEL,
    openedAt: Math.min(startAt, segments[0]?.openedAt ?? startAt),
    closedAt: deployAt,
    openTxHashes: null,
    closeTxHashes: null,
    accounting: recomputeNetPnl({ priceDriftUsd: differenceUsd }),
    baselineAccounting: {},
    coverage: null,
  });
  segments.sort((a, b) => a.openedAt - b.openedAt);
  return { segments, differenceUsd };
}

/**
 * Tramo historico efectivo de un orquestador: el sembrado (deploy) o, si ya
 * hubo backfill, la suma de los tramos backfill (misma fecha de despliegue).
 */
function resolveHistoricalSegment(segments) {
  const closed = (segments || []).filter((s) => s.status === 'closed' && s.accuracy === 'approximate');
  const seeded = closed.find((s) => s.openReason === 'deploy');
  if (seeded) return seeded;
  const backfill = closed.filter((s) => s.openReason === 'backfill');
  if (!backfill.length) return null;
  return {
    openedAt: Math.min(...backfill.map((s) => s.openedAt)),
    closedAt: Math.max(...backfill.map((s) => s.closedAt)),
    accounting: {
      totalNetPnlUsd: backfill.reduce((acc, s) => acc + num(s.accounting?.totalNetPnlUsd), 0),
    },
  };
}

module.exports = {
  DIFFERENCE_LABEL,
  buildHistoricalSegments,
  resolveHistoricalSegment,
};
