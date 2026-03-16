/**
 * OrdersSection.jsx — Open orders display with cancel functionality
 */

import styles from './TradingPanel.module.css';

export function OrdersSection({ openOrders, cancellingOid, onCancelOrder }) {
  if (openOrders.length === 0) return null;

  return (
    <>
      <div className={styles.ordersHeader}>
        <span className={styles.colLabel}>
          Ordenes abiertas
          <span className={styles.badge}>{openOrders.length}</span>
        </span>
      </div>
      {openOrders.map((order) => {
        const isBuy = order.side === 'B';
        return (
          <div key={order.oid} className={styles.orderRow}>
            <div className={styles.orderLeft}>
              <span className={styles.orderAsset}>{order.coin}</span>
              <span className={`${styles.orderBadge} ${isBuy ? styles.longBadge : styles.shortBadge}`}>
                {isBuy ? '▲ Buy' : '▼ Sell'}
              </span>
              <span className={styles.orderType}>{order.orderType ?? 'Limit'}</span>
            </div>
            <div className={styles.orderMid}>
              <span className={styles.orderDetail}>{parseFloat(order.sz).toFixed(4)} @ ${parseFloat(order.limitPx).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
            </div>
            <button
              className={styles.cancelBtn}
              onClick={() => onCancelOrder(order.coin, order.oid)}
              disabled={cancellingOid === order.oid}
              aria-label={`Cancelar orden ${order.coin}`}
            >
              {cancellingOid === order.oid ? '...' : '✕'}
            </button>
          </div>
        );
      })}
    </>
  );
}
