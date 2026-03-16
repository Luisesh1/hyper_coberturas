/**
 * PositionsList.jsx — Right column: list of open positions with close buttons
 */

import styles from './TradingPanel.module.css';

export function PositionsList({
  positions,
  positionCount,
  prices,
  leverage,
  isLoadingAccount,
  selectedAccountId,
  closingAsset,
  onClose,
  onOpenSltp,
}) {
  return (
    <>
      {isLoadingAccount && <p className={styles.empty}>Cargando posiciones...</p>}
      {!isLoadingAccount && selectedAccountId && positionCount === 0 && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>◈</span>
          <span>Sin posiciones abiertas</span>
          <span className={styles.emptyHint}>Usa el formulario para abrir tu primera posicion</span>
        </div>
      )}
      {!selectedAccountId && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>◈</span>
          <span>Selecciona una cuenta</span>
          <span className={styles.emptyHint}>El estado y las ordenes dependen de la cuenta elegida arriba</span>
        </div>
      )}

      {positions?.map((pos) => {
        const entryPx    = parseFloat(pos.entryPrice || 0);
        const posSize    = Math.abs(parseFloat(pos.size));
        const marginUsed = parseFloat(pos.marginUsed || 0);
        const isLong     = pos.side === 'long';
        const markPx     = prices[pos.asset] ? parseFloat(prices[pos.asset]) : null;

        // Live unrealized PnL calculated from WS price
        const livePnl = markPx && entryPx
          ? (isLong ? 1 : -1) * (markPx - entryPx) * posSize
          : parseFloat(pos.unrealizedPnl || 0);
        const liveRoe = marginUsed > 0 ? livePnl / marginUsed : 0;

        return (
          <div key={pos.asset} className={styles.posCard}>
            <div className={styles.posHeader}>
              <div className={styles.posLeft}>
                <span className={styles.posAsset}>{pos.asset}</span>
                <span className={`${styles.posBadge} ${isLong ? styles.longBadge : styles.shortBadge}`}>
                  {isLong ? '▲ L' : '▼ S'} {pos.leverage?.value ?? leverage}x
                </span>
                <span className={`${styles.pnlInline} ${livePnl >= 0 ? styles.positive : styles.negative}`}>
                  {livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}
                </span>
              </div>
              <div className={styles.posBtns}>
                <button className={styles.sltpBtn} onClick={() => onOpenSltp(pos)}>SL/TP</button>
                <button
                  className={styles.closeBtn}
                  onClick={() => onClose(pos.asset)}
                  disabled={closingAsset === pos.asset}
                >
                  {closingAsset === pos.asset ? 'Cerrando...' : 'Cerrar todo'}
                </button>
              </div>
            </div>

            <div className={styles.posGrid}>
              <div className={styles.posDetail}>
                <span className={styles.detailLabel}>Tamano</span>
                <span className={styles.detailVal}>{posSize.toFixed(4)} {pos.asset}</span>
              </div>
              <div className={styles.posDetail}>
                <span className={styles.detailLabel}>Entrada</span>
                <span className={styles.detailVal}>${entryPx.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              </div>
              <div className={styles.posDetail}>
                <span className={styles.detailLabel}>Actual</span>
                <span className={styles.detailVal}>{markPx ? `$${markPx.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}</span>
              </div>
              {pos.liquidationPrice && (
                <div className={styles.posDetail}>
                  <span className={styles.detailLabel}>Liquidacion</span>
                  <span className={`${styles.detailVal} ${styles.liqPrice}`}>${parseFloat(pos.liquidationPrice).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className={styles.posDetail}>
                <span className={styles.detailLabel}>Margen</span>
                <span className={styles.detailVal}>${marginUsed.toFixed(2)}</span>
              </div>
              <div className={styles.posDetail}>
                <span className={styles.detailLabel}>ROE</span>
                <span className={`${styles.detailVal} ${liveRoe >= 0 ? styles.positive : styles.negative}`}>
                  {(liveRoe * 100).toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
