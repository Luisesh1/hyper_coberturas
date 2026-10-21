import { useState } from 'react';
import Sparkline from './Sparkline';
import WalletDetail from './WalletDetail';
import { fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { shortAddress } from '../lib/labels';
import styles from '../MetricasPage.module.css';

function Chevron({ open }) {
  return (
    <svg className={styles.rowChevron} width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Sin permiso de portapapeles: la direccion completa sigue en el title.
    }
  };
  return (
    <button type="button" className={styles.copyBtn} onClick={copy} aria-label={`Copiar ${text}`} title={text}>
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export default function WalletRow({ wallet, points, change, range, expanded, onToggle, onStatusChange, loading }) {
  const tone = change == null ? '' : (change.changeUsd >= 0 ? styles.statDeltaPos : styles.statDeltaNeg);
  const latest = wallet.latest;
  const label = wallet.label || shortAddress(wallet.address);

  return (
    <div className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`}>
      <div className={styles.rowHeaderWrap}>
        <button type="button" className={styles.rowHeader} aria-expanded={expanded} onClick={onToggle}>
          <span className={styles.rowIdentity}>
            <Chevron open={expanded} />
            <span className={`${styles.rowName} ${styles.mono}`} title={wallet.address}>{label}</span>
            {wallet.status === 'archived' && <span className={styles.rowBadge}>Archivada</span>}
            {latest?.isPartial && (
              <span className={`${styles.rowBadge} ${styles.rowBadgeWarn}`} title="Alguna fuente usa su último valor conocido">
                Parcial
              </span>
            )}
            {!latest && !loading && <span className={styles.rowBadge}>Pendiente de captura</span>}
          </span>

          <span className={styles.rowSpark}>
            <Sparkline
              values={points.map((p) => p.total)}
              stretch
              width={160}
              stroke={change && change.changeUsd < 0 ? '#ef4444' : '#22c55e'}
              ariaLabel={`Tendencia de ${label} en ${range?.label || 'el rango'}`}
            />
          </span>

          <span className={`${styles.rowNumber} ${styles.rowNumberStrong}`}>
            {latest ? fmtUsd(latest.totals.totalUsd) : '—'}
          </span>
          <span className={`${styles.rowNumber} ${tone}`}>
            {change ? fmtSignedUsd(change.changeUsd) : '—'}
            {change?.changePct != null && <span className={styles.rowPct}>{fmtPct(change.changePct)}</span>}
          </span>
        </button>
        <CopyButton text={wallet.address} />
      </div>

      {expanded && (
        <div className={styles.rowDetail}>
          <WalletDetail wallet={wallet} points={points} onStatusChange={onStatusChange} />
        </div>
      )}
    </div>
  );
}
