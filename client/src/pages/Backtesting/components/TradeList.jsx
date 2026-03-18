import { TRADE_FILTERS } from '../../../components/Backtesting/backtesting-utils';
import { formatDate, formatNumber } from '../../../utils/formatters';
import styles from './BottomPanel.module.css';

function TradeList({
  visibleTrades,
  tradeFilter,
  setTradeFilter,
  focusedTradeId,
  setFocusedTradeId,
}) {
  return (
    <div className={styles.tabContent}>
      <div className={styles.filterBar}>
        {TRADE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.filterBtn} ${tradeFilter === f ? styles.filterBtnActive : ''}`}
            onClick={() => setTradeFilter(f)}
          >
            {f}
          </button>
        ))}
        <span className={styles.filterCount}>{visibleTrades.length} trades</span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Side</th>
              <th>Entrada</th>
              <th>Salida</th>
              <th>Qty</th>
              <th>PnL</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {visibleTrades.map((trade, i) => {
              const rowId = `${trade.entryTime}-${i}`;
              const active = focusedTradeId === rowId;
              const pnl = Number(trade.pnl);
              return (
                <tr
                  key={rowId}
                  className={active ? styles.rowActive : ''}
                  onClick={() => setFocusedTradeId(rowId)}
                >
                  <td>
                    <span className={trade.side === 'long' ? styles.dotLong : styles.dotShort} />
                    {trade.side}
                  </td>
                  <td>
                    <strong>{formatNumber(trade.entryPrice, 2)}</strong>
                    <small>{formatDate(trade.entryTime)}</small>
                  </td>
                  <td>
                    <strong>{formatNumber(trade.exitPrice, 2)}</strong>
                    <small>{formatDate(trade.exitTime)}</small>
                  </td>
                  <td>{formatNumber(trade.qty, 4)}</td>
                  <td className={pnl >= 0 ? styles.pnlPositive : styles.pnlNegative}>
                    {pnl >= 0 ? '+' : ''}{formatNumber(pnl, 2)}
                  </td>
                  <td>{trade.reason}</td>
                </tr>
              );
            })}
            {!visibleTrades.length && (
              <tr><td colSpan="6" className={styles.emptyCell}>No hay trades para este filtro.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default TradeList;
