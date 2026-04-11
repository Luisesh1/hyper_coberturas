import { useState, useEffect, useCallback } from 'react';
import { lpOrchestratorApi } from '../../../services/api';
import { formatNumber } from '../../../utils/formatters';
import styles from './ProtectionOpsPanel.module.css';

const HEDGE_STATUS_LABELS = {
  entry_pending: 'Pendiente',
  entry_filled_pending_sl: 'Llenado',
  open_protected: 'Activo',
  closing: 'Cerrando',
  waiting: 'Esperando',
  closed: 'Cerrado',
  cancelled: 'Cancelado',
};

function formatTs(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleString('es-MX', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}$${formatNumber(Math.abs(n), 2)}`;
}

function formatQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return formatNumber(n, 4);
}

function signClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return styles.neutral;
  return n > 0 ? styles.positive : styles.negative;
}

function statusTone(status) {
  if (status === 'open_protected') return styles.positive;
  if (status === 'entry_pending' || status === 'closing') return styles.neutral;
  if (status === 'waiting') return styles.muted;
  return styles.neutral;
}

const REBALANCE_REASON_LABELS = {
  price_move: 'Mov. precio',
  interval: 'Intervalo',
  manual: 'Manual',
  initial: 'Inicial',
  tracking_drift: 'Deriva',
  reentry: 'Reentrada',
  flip: 'Flip',
};

export default function ProtectionOpsPanel({ orchestratorId, hasProtection }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchOps = useCallback(async () => {
    if (!orchestratorId || !hasProtection) return;
    setLoading(true);
    setError(null);
    try {
      const result = await lpOrchestratorApi.getProtectionOps(orchestratorId);
      setData(result);
    } catch (err) {
      setError(err.message || 'Error al cargar operaciones');
    } finally {
      setLoading(false);
    }
  }, [orchestratorId, hasProtection]);

  useEffect(() => {
    if (open && !data && !loading) {
      fetchOps();
    }
  }, [open, data, loading, fetchOps]);

  if (!hasProtection) return null;

  const rebalances = data?.rebalances || [];
  const hedges = data?.hedges || [];
  const allCycles = hedges.flatMap((h) =>
    (h.cycles || []).map((c) => ({ ...c, asset: h.asset, direction: h.direction, role: h.protectedRole }))
  );

  const totalRebalanceCost = rebalances.reduce((sum, r) => {
    return sum + (Number(r.executionFeeUsd) || 0) + (Number(r.slippageUsd) || 0);
  }, 0);
  const totalCyclePnl = allCycles.reduce((sum, c) => sum + (Number(c.netPnl) || 0), 0);

  const hintParts = [];
  if (rebalances.length > 0) hintParts.push(`${rebalances.length} rebalanceos`);
  if (allCycles.length > 0) hintParts.push(`${allCycles.length} ciclos`);

  return (
    <details
      className={styles.block}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.summary}>
        <span>🛡 Operaciones proteccion</span>
        <span className={styles.summaryHint}>
          {data ? (hintParts.length > 0 ? hintParts.join(' · ') : 'sin operaciones') : ''}
        </span>
      </summary>

      <div className={styles.body}>
        {loading && <div className={styles.loading}>Cargando operaciones...</div>}
        {error && <div className={styles.loading}>{error}</div>}

        {data && !loading && (
          <>
            {/* Hedge status cards */}
            {hedges.length > 0 && (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>Hedges activos</span>
                <div className={styles.hedgeRow}>
                  {hedges.map((h) => (
                    <div key={h.id} className={styles.hedgeCard}>
                      <span className={styles.hedgeLabel}>
                        {h.protectedRole || h.direction} · {h.asset}
                      </span>
                      <span className={styles.hedgeValue}>
                        <span className={h.direction === 'short' ? styles.dirShort : styles.dirLong}>
                          {h.direction?.toUpperCase()}
                        </span>
                        {' '}{formatQty(h.positionSize || h.size)} @ {formatNumber(h.openPrice || h.entryPrice, 2)}
                      </span>
                      <span className={`${styles.hedgeStatus} ${statusTone(h.status)}`}>
                        {HEDGE_STATUS_LABELS[h.status] || h.status}
                        {h.unrealizedPnl != null && (
                          <span className={signClass(h.unrealizedPnl)}>
                            {' '}PnL: {formatUsd(h.unrealizedPnl)}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Rebalance operations table */}
            {rebalances.length > 0 && (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>
                  Rebalanceos ({rebalances.length})
                  {totalRebalanceCost > 0 && (
                    <span className={styles.negative}> · costo total: ${formatNumber(totalRebalanceCost, 2)}</span>
                  )}
                </span>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Razon</th>
                      <th>Precio</th>
                      <th>Qty antes</th>
                      <th>Qty despues</th>
                      <th>Drift</th>
                      <th>Fee</th>
                      <th>Slippage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebalances.map((r) => (
                      <tr key={r.id}>
                        <td className={styles.muted}>{formatTs(r.createdAt)}</td>
                        <td className={styles.reason}>
                          {REBALANCE_REASON_LABELS[r.reason] || r.reason || '—'}
                        </td>
                        <td>{r.price != null ? formatNumber(r.price, 2) : '—'}</td>
                        <td>{formatQty(r.actualQtyBefore)}</td>
                        <td>{formatQty(r.actualQtyAfter)}</td>
                        <td className={signClass(r.driftUsd)}>{formatUsd(r.driftUsd)}</td>
                        <td className={styles.negative}>
                          {r.executionFeeUsd != null ? `$${formatNumber(r.executionFeeUsd, 2)}` : '—'}
                        </td>
                        <td className={styles.negative}>
                          {r.slippageUsd != null ? `$${formatNumber(r.slippageUsd, 2)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Hedge cycles table */}
            {allCycles.length > 0 && (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>
                  Ciclos de hedge ({allCycles.length})
                  <span className={signClass(totalCyclePnl)}> · PnL total: {formatUsd(totalCyclePnl)}</span>
                </span>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Apertura</th>
                      <th>Cierre</th>
                      <th>Rol</th>
                      <th>Precio in</th>
                      <th>Precio out</th>
                      <th>PnL bruto</th>
                      <th>Fees</th>
                      <th>Funding</th>
                      <th>PnL neto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allCycles.map((c, i) => (
                      <tr key={i}>
                        <td className={styles.muted}>{formatTs(c.openedAt)}</td>
                        <td className={styles.muted}>{formatTs(c.closedAt)}</td>
                        <td>
                          <span className={c.direction === 'short' ? styles.dirShort : styles.dirLong}>
                            {c.role || c.direction}
                          </span>
                        </td>
                        <td>{c.openPrice != null ? formatNumber(c.openPrice, 2) : '—'}</td>
                        <td>{c.closePrice != null ? formatNumber(c.closePrice, 2) : '—'}</td>
                        <td className={signClass(c.closedPnl)}>{formatUsd(c.closedPnl)}</td>
                        <td className={styles.negative}>
                          ${formatNumber((c.entryFee || 0) + (c.exitFee || 0), 2)}
                        </td>
                        <td className={signClass(c.fundingPaid)}>{formatUsd(c.fundingPaid)}</td>
                        <td className={signClass(c.netPnl)}>
                          <strong>{formatUsd(c.netPnl)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {rebalances.length === 0 && allCycles.length === 0 && hedges.length === 0 && (
              <div className={styles.empty}>Sin operaciones de proteccion registradas</div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
