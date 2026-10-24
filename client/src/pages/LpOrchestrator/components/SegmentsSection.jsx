import { useCallback, useEffect, useState } from 'react';
import { lpOrchestratorApi } from '../../../services/api';
import { formatSignedUsd, formatUsd } from '../../UniswapPools/utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { lpBreakdownItems, hedgeBreakdownItems, signTone } from './accountingBreakdown';
import { segmentRowModel, hasReconstructionGap, formatSegmentDate } from './segmentsSummary';
import styles from './SegmentsSection.module.css';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasHedge(a) {
  return ['hedgeRealizedPnlUsd', 'hedgeUnrealizedPnlUsd', 'hedgeFundingUsd', 'hedgeExecutionFeesUsd', 'hedgeSlippageUsd']
    .some((k) => num(a?.[k]) !== 0);
}

function Cells({ items }) {
  return (
    <div className={styles.cells}>
      {items.map((item) => (
        <div key={item.label} className={styles.cell}>
          <span className={styles.cellLabel}>{item.label}</span>
          <span className={`${styles.cellValue} ${styles[item.tone] || ''}`}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function SegmentDetail({ orchestratorId, segment }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    lpOrchestratorApi.getSegment(orchestratorId, segment.id)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Error al cargar el tramo'); });
    return () => { cancelled = true; };
  }, [orchestratorId, segment.id]);

  const a = segment.accounting || {};
  const rebalances = detail?.rebalances || [];
  return (
    <div className={styles.detail}>
      <span className={styles.detailRange}>Rango {segmentRowModel(segment).range}</span>
      <Cells items={lpBreakdownItems(a)} />
      {hasHedge(a) && <Cells items={hedgeBreakdownItems(a)} />}
      <div className={styles.rebalances}>
        <span className={styles.subTitle}>Reajustes del short</span>
        {error && <span className={styles.muted}>{error}</span>}
        {!error && !detail && <span className={styles.muted}>Cargando…</span>}
        {detail && rebalances.length === 0 && <span className={styles.muted}>Sin reajustes</span>}
        {rebalances.map((r) => (
          <div key={r.id} className={styles.rebalanceRow}>
            <span>{formatSegmentDate(r.createdAt)}</span>
            <span>{r.reason || '—'}</span>
            <span>{formatNumber(num(r.actualQtyAfter), 4)} / {formatNumber(num(r.targetQtyAfter), 4)}</span>
            <span className={styles.negative}>
              -{formatUsd(num(r.executionFeeUsd) + num(r.slippageUsd))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SegmentRow({ orchestratorId, segment }) {
  const [open, setOpen] = useState(false);
  const row = segmentRowModel(segment);
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.seq}>{row.title}</span>
        <span className={styles.meta}>
          <span className={styles.dates}>{row.dates}</span>
          <span className={`${styles.reason} ${row.live ? styles.live : ''}`}>
            {row.reason}
            {row.approximate && <span className={styles.badge}>aproximado</span>}
          </span>
        </span>
        <span className={styles.range}>{row.range}</span>
        <span className={`${styles.net} ${styles[row.netTone]}`}>{row.netText}</span>
        <span className={styles.coverage}>{row.coverageText}</span>
      </button>
      {open && <SegmentDetail orchestratorId={orchestratorId} segment={segment} />}
    </li>
  );
}

/**
 * Tramos del orquestador: cada LP (un rango) es un tramo con su P&L. Carga al
 * desplegarse (no una petición por tarjeta) y se refresca si cambia
 * `refreshKey` con la sección abierta.
 */
export default function SegmentsSection({ orchestratorId, refreshKey = null }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await lpOrchestratorApi.listSegments(orchestratorId));
      setError(null);
    } catch (err) {
      setError(err.message || 'Error al cargar los tramos');
    }
  }, [orchestratorId]);

  useEffect(() => {
    if (open) load();
  }, [open, load, refreshKey]);

  const segments = data?.segments || [];
  const diff = data?.totals?.differenceUsd;
  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.title}>Tramos</span>
        {data && <span className={styles.count}>{segments.length}</span>}
        <span className={styles.chevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {error && <span className={styles.muted}>{error}</span>}
          {!error && !data && <span className={styles.muted}>Cargando…</span>}
          {data && segments.length === 0 && <span className={styles.muted}>Sin tramos todavía</span>}
          {segments.length > 0 && (
            <ul className={styles.list}>
              {segments.map((s) => (
                <SegmentRow key={s.id} orchestratorId={orchestratorId} segment={s} />
              ))}
            </ul>
          )}
          {data && hasReconstructionGap(diff) && (
            <div className={styles.gap}>
              <span>Diferencia de reconstrucción</span>
              <strong className={styles[signTone(diff)]}>{formatSignedUsd(diff)}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
