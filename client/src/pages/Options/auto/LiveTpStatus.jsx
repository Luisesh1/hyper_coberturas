import ui from '../strategies/common/ui.module.css';
import styles from './AutoTradingTab.module.css';

const LABEL = {
  queued: 'Preparando',
  sending: 'Por confirmar',
  active: 'Activa',
  attention: 'Revisar',
  final: 'Finalizada',
};

export default function LiveTpStatus({ bot }) {
  const orders = (Array.isArray(bot?.takeProfitOrders) ? bot.takeProfitOrders : [])
    .filter((o) => o && o.status !== 'final');
  const openPositions = (Array.isArray(bot?.positions) ? bot.positions : [])
    .filter((p) => p?.mode === 'live' && p.closedAt == null);
  if (bot?.mode !== 'live' || (!orders.length && !openPositions.length)) return null;

  const attention = orders.some((o) => o.status === 'attention');
  const cancelling = orders.some((o) => o.cancelRequested);
  const pending = orders.some((o) => ['queued', 'sending'].includes(o.status));
  const live = orders.filter((o) => o.status === 'active' && !o.cancelRequested).length;
  const label = attention ? 'TP requiere revisión'
    : cancelling ? 'Cancelando TP'
      : pending ? 'TP por confirmar'
        : orders.length ? `TP activo · ${live}`
          : 'TP sin confirmar';
  const tone = attention || (!orders.length && openPositions.length) ? ui.alertWarn : '';
  return (
    <section aria-label="Estado del Take Profit" className={styles.tpStatus}>
      <div className={`${styles.tpStatusHeader} ${tone}`} role="status">
        <span className={styles.tpDot} aria-hidden="true" />
        <strong>{label}</strong>
        <span className={ui.muted}>{orders.length ? `${orders.length} órdenes` : `${openPositions.length} posiciones`}</span>
      </div>
      {orders.length > 0 && (
        <details className={styles.tpDetails}>
          <summary>Ver órdenes</summary>
          <ul className={styles.tpList}>
            {orders.map((o) => (
              <li key={o.id}>
                <span>{o.symbol}</span>
                <strong>{o.cancelRequested ? 'Cancelando' : LABEL[o.status] || 'Pendiente'}</strong>
                <span className={ui.muted}>{o.executedQty} / {o.quantity} · {o.price} USDT</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
