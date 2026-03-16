import { useState } from 'react';
import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { STATUS_LABEL, calcCyclePnl, fmt } from './constants';
import { CycleRow } from './CycleRow';
import styles from './HedgePanel.module.css';

/* -- Tarjeta individual de cobertura -- */
export function HedgeCard({ hedge, currentPrice, onCancel }) {
  const [showHistory, setShowHistory] = useState(false);

  const isLong  = hedge.direction === 'long';
  const st      = STATUS_LABEL[hedge.status] || { text: hedge.status, color: '#64748b' };
  const pct     = currentPrice && hedge.entryPrice
    ? ((currentPrice - hedge.entryPrice) / hedge.entryPrice * 100).toFixed(2)
    : null;
  const isActive = ['open', 'open_protected', 'entry_filled_pending_sl'].includes(hedge.status);
  const cycles   = hedge.cycles || [];

  // Acumulados de todos los ciclos
  const totals = cycles.reduce((acc, c) => {
    const { gross, fees, funding, net } = calcCyclePnl(c, hedge.size, hedge.direction);
    return {
      net:     acc.net     + (net     ?? 0),
      gross:   acc.gross   + (gross   ?? 0),
      fees:    acc.fees    + fees,
      funding: acc.funding + funding,
      hasData: acc.hasData || net != null,
    };
  }, { net: 0, gross: 0, fees: 0, funding: 0, hasData: false });

  return (
    <div className={`${styles.card} ${isActive ? (isLong ? styles.cardActiveLong : styles.cardActive) : ''}`}>
      {/* Cabecera */}
      <div className={styles.cardHeader}>
        <div className={styles.cardLeft}>
          <span className={styles.cardAsset}>{hedge.asset}</span>
          <span className={isLong ? styles.longTag : styles.shortTag}>
            {isLong ? 'LONG' : 'SHORT'} {hedge.leverage}x
          </span>
          <span className={styles.statusDot} style={{ color: st.color }}>● {st.text}</span>
          {cycles.length > 0 && (
            <span className={styles.cycleCountBadge}>{cycles.length} ciclo{cycles.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className={styles.cardActions}>
          {cycles.length > 0 && (
            <button className={styles.historyBtn}
              onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '▲' : '▼'} Historial
            </button>
          )}
          {onCancel && ['waiting', 'entry_pending', 'entry_filled_pending_sl', 'open', 'open_protected', 'cancel_pending'].includes(hedge.status) && (
            <button className={styles.cancelBtn} onClick={() => onCancel(hedge.id, hedge.asset)}>Cancelar</button>
          )}
        </div>
      </div>

      {hedge.account && (
        <div className={styles.accountMeta}>{formatAccountIdentity(hedge.account)}</div>
      )}
      {hedge.label && <div className={styles.cardLabel}>{hedge.label}</div>}

      {/* Datos en grid 3-col */}
      <div className={styles.cardGrid}>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Entrada</span>
          <span className={`${styles.cardItemVal} ${isLong ? styles.triggerUp : styles.triggerDown}`}>
            {isLong ? '≥' : '≤'} ${Number(hedge.entryPrice).toLocaleString()}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Salida SL</span>
          <span className={`${styles.cardItemVal} ${isLong ? styles.triggerDown : styles.triggerUp}`}>
            {isLong ? '≤' : '≥'} ${Number(hedge.exitPrice).toLocaleString()}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Precio actual</span>
          <span className={styles.cardItemVal}>
            {currentPrice
              ? `$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
              : '—'}
            {pct !== null && (
              <span className={parseFloat(pct) >= 0 ? styles.up : styles.down}>
                {' '}({parseFloat(pct) >= 0 ? '+' : ''}{pct}%)
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardItem}>
          <span className={styles.cardItemLabel}>Tamano</span>
          <span className={styles.cardItemVal}>{parseFloat(hedge.size).toFixed(6)} {hedge.asset}</span>
          {hedge.entryPrice && (
            <span className={styles.cardItemSub}>
              ≈ ${(parseFloat(hedge.size) * parseFloat(hedge.entryPrice)).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
            </span>
          )}
        </div>
        {hedge.entryOid && hedge.status === 'entry_pending' && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>Orden GTC (oid)</span>
            <span className={styles.cardItemVal}>{hedge.entryOid}</span>
          </div>
        )}
        {hedge.openPrice && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>Apertura</span>
            <span className={styles.cardItemVal}>${Number(hedge.openPrice).toLocaleString()}</span>
          </div>
        )}
        {hedge.unrealizedPnl != null && ['open', 'open_protected'].includes(hedge.status) && (
          <div className={styles.cardItem}>
            <span className={styles.cardItemLabel}>PnL no realizado</span>
            <span className={hedge.unrealizedPnl >= 0 ? styles.pnlPositive : styles.pnlNegative}>
              {fmt(Number(hedge.unrealizedPnl))} USDC
            </span>
          </div>
        )}
        {cycles.length > 0 && (
          <div className={`${styles.cardItem} ${styles.pnlSummaryItem}`}>
            <span className={styles.cardItemLabel}>PnL neto acum.</span>
            <span className={totals.net >= 0 ? styles.pnlPositive : styles.pnlNegative}>
              {fmt(totals.net)} USDC
            </span>
            <span className={styles.cardItemSub}>
              bruto {fmt(totals.gross, 2)} · fees -{totals.fees.toFixed(4)} · fund {fmt(totals.funding, 4)}
            </span>
          </div>
        )}
      </div>

      {hedge.error && (
        <div className={styles.cardError}>Error: {hedge.error}</div>
      )}

      <div className={styles.cardMeta}>
        <span>Creada: {new Date(hedge.createdAt).toLocaleString()}</span>
        {hedge.openedAt && <span>Abierta: {new Date(hedge.openedAt).toLocaleString()}</span>}
        {hedge.closedAt && <span>Cerrada: {new Date(hedge.closedAt).toLocaleString()}</span>}
      </div>

      {showHistory && cycles.length > 0 && (
        <div className={styles.cycleHistory}>
          <div className={styles.cycleHistoryTitle}>Historial de ciclos ({cycles.length})</div>
          {[...cycles].reverse().map((c) => (
            <CycleRow
              key={c.cycleId}
              cycle={{ ...c, asset: hedge.asset, label: hedge.label, leverage: hedge.leverage, direction: hedge.direction, account: hedge.account, accountId: hedge.accountId }}
              hedgeSize={hedge.size}
            />
          ))}
        </div>
      )}
    </div>
  );
}
