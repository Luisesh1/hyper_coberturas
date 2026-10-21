import { useMemo, useState } from 'react';
import { fmtUsd } from '../lib/format';
import { networkLabel } from '../lib/labels';
import styles from '../MetricasPage.module.css';

const DUST_USD = 1;

function fmtAmount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toPrecision(3);
}

function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(4);
}

function collect(sources, prefix) {
  return Object.entries(sources || {})
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, src]) => (src.items || []).map((item) => ({ ...item, sourceStale: src.stale })));
}

function TokenList({ sources }) {
  const [showAll, setShowAll] = useState(false);
  const tokens = useMemo(
    () => collect(sources, 'tokens:').sort((a, b) => (b.usd || 0) - (a.usd || 0)),
    [sources]
  );
  const main = tokens.filter((t) => t.priced && t.usd >= DUST_USD);
  const dust = tokens.filter((t) => t.priced && t.usd < DUST_USD);
  const unpriced = tokens.filter((t) => !t.priced);
  const shown = showAll ? [...main, ...dust, ...unpriced] : main;
  const hiddenCount = dust.length + unpriced.length;

  return (
    <div className={styles.holdingGroup}>
      <h4 className={styles.holdingTitle}>Tokens</h4>
      {shown.length === 0 && <p className={styles.holdingEmpty}>Sin tokens con valor.</p>}
      <ul className={styles.holdingList}>
        {shown.map((t) => (
          <li key={`${t.network}:${t.address}`} className={styles.holdingRow}>
            <span className={styles.holdingName}>
              <strong>{t.symbol}</strong>
              <span className={styles.holdingMeta}>{networkLabel(t.network)}</span>
              {t.sourceStale && <span className={`${styles.rowBadge} ${styles.rowBadgeWarn}`}>último valor</span>}
            </span>
            <span className={styles.holdingAmount}>{fmtAmount(t.balance)}</span>
            <span className={styles.holdingUsd}>{t.priced ? fmtUsd(t.usd) : 'sin precio'}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button type="button" className={styles.linkBtn} onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? 'Ocultar polvo y tokens sin precio'
            : `Mostrar ${dust.length ? `${dust.length} de menos de $1` : ''}${dust.length && unpriced.length ? ' y ' : ''}${unpriced.length ? `${unpriced.length} sin precio` : ''}`}
        </button>
      )}
    </div>
  );
}

function LpList({ sources }) {
  const lps = useMemo(
    () => collect(sources, 'lps:').sort((a, b) => (b.usd || 0) - (a.usd || 0)),
    [sources]
  );
  const knownOnly = Object.entries(sources || {})
    .filter(([key, src]) => key.startsWith('lps:') && src.meta?.knownIdsOnly)
    .map(([key]) => networkLabel(key.split(':')[1]));

  return (
    <div className={styles.holdingGroup}>
      <h4 className={styles.holdingTitle}>LPs</h4>
      {lps.length === 0 && <p className={styles.holdingEmpty}>Sin posiciones abiertas.</p>}
      <ul className={styles.holdingList}>
        {lps.map((lp) => (
          <li key={lp.id} className={styles.holdingRow}>
            <span className={styles.holdingName}>
              <strong>{lp.token0Symbol}/{lp.token1Symbol}</strong>
              <span className={styles.holdingMeta}>
                {networkLabel(lp.network)} · {lp.version} #{lp.tokenId}
              </span>
              {lp.inRange != null && (
                <span className={`${styles.rowBadge} ${lp.inRange ? styles.rowBadgeOk : styles.rowBadgeWarn}`}>
                  {lp.inRange ? 'en rango' : 'fuera de rango'}
                </span>
              )}
              {(lp.stale || lp.sourceStale) && (
                <span className={`${styles.rowBadge} ${styles.rowBadgeWarn}`}>último valor</span>
              )}
            </span>
            <span className={styles.holdingAmount}>
              {lp.rangeLowerPrice != null && lp.rangeUpperPrice != null
                ? `${fmtPrice(lp.rangeLowerPrice)} – ${fmtPrice(lp.rangeUpperPrice)}`
                : ''}
            </span>
            <span className={styles.holdingUsd}>
              {fmtUsd(lp.usd)}
              {lp.feesUsd > 0 && <span className={styles.holdingMeta}> · fees {fmtUsd(lp.feesUsd)}</span>}
            </span>
          </li>
        ))}
      </ul>
      {knownOnly.length > 0 && (
        <p className={styles.holdingNote}>
          En {knownOnly.join(', ')} no hay indexador de posiciones v4: solo se ven los LPs creados desde la app.
        </p>
      )}
    </div>
  );
}

function HyperliquidBlock({ source }) {
  if (!source) return null;
  const meta = source.meta || {};
  const spot = (source.items || []).filter((b) => b.amount > 0);
  return (
    <div className={styles.holdingGroup}>
      <h4 className={styles.holdingTitle}>Hyperliquid</h4>
      <ul className={styles.holdingList}>
        <li className={styles.holdingRow}>
          <span className={styles.holdingName}>
            <strong>Perps</strong>
            <span className={styles.holdingMeta}>
              {meta.positionsCount ? `${meta.positionsCount} posición${meta.positionsCount === 1 ? '' : 'es'} abierta${meta.positionsCount === 1 ? '' : 's'}` : 'sin posiciones'}
            </span>
            {source.stale && <span className={`${styles.rowBadge} ${styles.rowBadgeWarn}`}>último valor</span>}
          </span>
          <span className={styles.holdingAmount} />
          <span className={styles.holdingUsd}>{fmtUsd(meta.perpUsd ?? source.usd)}</span>
        </li>
        {spot.map((b) => (
          <li key={b.token} className={styles.holdingRow}>
            <span className={styles.holdingName}>
              <strong>{b.coin}</strong>
              <span className={styles.holdingMeta}>
                spot{b.countedInPerp ? ' · colateral de perps (cuenta unificada)' : ''}
              </span>
            </span>
            <span className={styles.holdingAmount}>{fmtAmount(b.amount)}</span>
            <span className={styles.holdingUsd}>{b.priced ? fmtUsd(b.usd) : 'sin precio'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lo que tiene la wallet en la ultima captura (o en la lectura al momento). */
export default function WalletHoldings({ detail }) {
  if (!detail) return null;
  return (
    <div className={styles.holdings}>
      <TokenList sources={detail.sources} />
      <LpList sources={detail.sources} />
      <HyperliquidBlock source={detail.sources?.hl} />
    </div>
  );
}
