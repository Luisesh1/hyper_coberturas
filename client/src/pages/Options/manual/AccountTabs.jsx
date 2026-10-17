import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import CloseAtPriceForm from './CloseAtPriceForm';
import { fmtDateTime, fmtNum, fmtPrice, fmtSigned, toneOf } from '../format';
import { orderView, positionView, tradeView } from './accountRows';
import styles from './ManualTrading.module.css';

const TABS = [
  { key: 'positions', label: 'Posiciones' },
  { key: 'orders', label: 'Órdenes abiertas' },
  { key: 'history', label: 'Historial' },
];

// Posiciones, órdenes abiertas e historial (escritorio).
export default function AccountTabs({
  tab, onTab, configured, positions, openOrders, trades, tradesLoading, pending, onClose, onCloseAtPrice, onCancel,
}) {
  const counts = { positions: positions.length, orders: openOrders.length, history: null };

  return (
    <section aria-label="Posiciones y órdenes" className={styles.card}>
      <div role="tablist" aria-label="Detalle de la cuenta" className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`opt-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="opt-account-panel"
            className={`${styles.tab} ${tab === t.key ? styles.tabOn : ''}`}
            onClick={() => onTab(t.key)}
          >
            {t.label}
            {configured && counts[t.key] != null && <span className={styles.tabCount}>{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      <div id="opt-account-panel" role="tabpanel" aria-labelledby={`opt-tab-${tab}`}>
        {!configured ? (
          <p className={styles.empty}>
            Conecta tu API key en <Link to="/config?section=binanceOptions">Configuración › Binance Opciones</Link> para ver posiciones y órdenes.
          </p>
        ) : tab === 'positions' ? (
          <PositionsTable positions={positions} pending={pending} onClose={onClose} onCloseAtPrice={onCloseAtPrice} />
        ) : tab === 'orders' ? (
          <OrdersTable orders={openOrders} pending={pending} onCancel={onCancel} />
        ) : (
          <HistoryTable trades={trades} loading={tradesLoading} />
        )}
      </div>
    </section>
  );
}

function PositionsTable({ positions, pending, onClose, onCloseAtPrice }) {
  const [editingSymbol, setEditingSymbol] = useState(null);
  if (!positions.length) return <p className={styles.empty}>Sin posiciones abiertas.</p>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.tbl}>
        <thead>
          <tr><th>Contrato</th><th>Lado</th><th>Cant.</th><th>Entrada</th><th>Mark</th><th>Prima actual</th><th>P&amp;L</th><th>Δ</th><th>Θ / día</th><th>Origen</th><th><span className={styles.srOnly}>Acciones</span></th></tr>
        </thead>
        <tbody>
          {positions.map((raw) => {
            const p = positionView(raw);
            return (
              <Fragment key={p.key}>
              <tr>
                <td className={`${styles.mono} ${styles.symbolCell}`}>{p.symbol}</td>
                <td className={p.long ? styles.up : styles.down}>{p.side}</td>
                <td className={styles.mono}>{fmtNum(p.qty, 2)}</td>
                <td className={styles.mono}>{fmtPrice(p.entry)}</td>
                <td className={styles.mono}>{fmtPrice(p.mark)}</td>
                <td className={styles.mono}>{p.premiumCurrent == null ? '—' : `${fmtNum(p.premiumCurrent, 2)} USDT`}</td>
                <td className={`${styles.mono} ${styles[toneOf(p.pnl)]}`}>{fmtSigned(p.pnl, 2)}</td>
                <td className={styles.mono}>{fmtSigned(p.delta, 3)}</td>
                <td className={styles.mono}>{fmtSigned(p.theta, 2)}</td>
                <td><span className={styles.originTag}>{p.origin}</span></td>
                <td className={styles.actionsCell}>
                  <button type="button" className={styles.ghostBtn} disabled={pending} onClick={() => onClose(raw)} aria-label={`Cerrar ${p.symbol}`}>
                    Cerrar
                  </button>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    disabled={pending}
                    aria-label={`Cerrar a precio ${p.symbol}`}
                    aria-expanded={editingSymbol === p.key}
                    onClick={() => setEditingSymbol(editingSymbol === p.key ? null : p.key)}
                  >
                    Cerrar a precio
                  </button>
                </td>
              </tr>
              {editingSymbol === p.key && (
                <tr>
                  <td colSpan={11} className={styles.closeAtPriceTableCell}>
                    <CloseAtPriceForm
                      position={raw}
                      pending={pending}
                      onSubmit={onCloseAtPrice}
                      onCancel={() => setEditingSymbol(null)}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTable({ orders, pending, onCancel }) {
  if (!orders.length) return <p className={styles.empty}>Sin órdenes abiertas.</p>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.tbl}>
        <thead>
          <tr><th>Contrato</th><th>Lado</th><th>Precio</th><th>Cant.</th><th>Ejecutado</th><th>Creada</th><th><span className={styles.srOnly}>Acciones</span></th></tr>
        </thead>
        <tbody>
          {orders.map((raw) => {
            const o = orderView(raw);
            return (
              <tr key={o.key}>
                <td className={`${styles.mono} ${styles.symbolCell}`}>{o.symbol}</td>
                <td className={o.side === 'BUY' ? styles.up : styles.down}>{o.side === 'BUY' ? 'Compra' : 'Venta'}</td>
                <td className={styles.mono}>{fmtPrice(o.price)}</td>
                <td className={styles.mono}>{fmtNum(o.qty, 2)}</td>
                <td className={styles.mono}>{fmtNum(o.filled, 2)}</td>
                <td className={styles.mono}>{fmtDateTime(o.created)}</td>
                <td className={styles.actionsCell}>
                  <button
                    type="button"
                    className={`${styles.ghostBtn} ${styles.dangerBtn}`}
                    disabled={pending}
                    onClick={() => onCancel(o)}
                    aria-label={`Cancelar orden ${o.symbol}`}
                  >
                    Cancelar
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ trades, loading }) {
  if (!trades.length) {
    return <p className={styles.empty}>{loading ? 'Cargando historial…' : 'Sin ejecuciones en los últimos 30 días.'}</p>;
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.tbl}>
        <thead>
          <tr><th>Fecha</th><th>Contrato</th><th>Lado</th><th>Precio</th><th>Cant.</th><th>Comisión</th><th>P&amp;L realizado</th></tr>
        </thead>
        <tbody>
          {trades.map((raw, i) => {
            const t = tradeView(raw, i);
            return (
              <tr key={t.key}>
                <td className={styles.mono}>{fmtDateTime(t.time)}</td>
                <td className={`${styles.mono} ${styles.symbolCell}`}>{t.symbol}</td>
                <td className={t.side === 'BUY' ? styles.up : styles.down}>{t.side === 'BUY' ? 'Compra' : 'Venta'}</td>
                <td className={styles.mono}>{fmtPrice(t.price)}</td>
                <td className={styles.mono}>{fmtNum(t.qty, 2)}</td>
                <td className={styles.mono}>{fmtNum(t.fee, 4)}</td>
                <td className={`${styles.mono} ${styles[toneOf(t.pnl)]}`}>{fmtSigned(t.pnl, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
