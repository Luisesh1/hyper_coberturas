import { formatDate, formatNumber } from '../../utils/formatters';
import { TRADE_FILTERS, toDatetimeLocal } from './backtesting-utils';
import styles from '../../pages/BacktestingPage.module.css';

function BacktestResults({
  result,
  visibleTrades,
  tradeFilter,
  setTradeFilter,
  focusedTradeId,
  setFocusedTradeId,
  selectedStrategy,
}) {
  return (
    <>
      <div className={styles.explorerLayout}>
        <section className={styles.tablePanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Trades</h2>
              <p>Haz click en un trade para centrar el chart en ese recorrido.</p>
            </div>
            <div className={styles.filterBar}>
              {TRADE_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`${styles.filterBtn} ${tradeFilter === filter ? styles.filterBtnActive : ''}`}
                  onClick={() => setTradeFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
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
                {visibleTrades.map((trade, index) => {
                  const rowId = `${trade.entryTime}-${index}`;
                  const active = focusedTradeId === rowId;
                  return (
                    <tr
                      key={rowId}
                      className={active ? styles.tableRowActive : ''}
                      onClick={() => setFocusedTradeId(rowId)}
                    >
                      <td>{trade.side}</td>
                      <td>
                        <strong>{formatNumber(trade.entryPrice, 2)}</strong>
                        <small>{formatDate(trade.entryTime)}</small>
                      </td>
                      <td>
                        <strong>{formatNumber(trade.exitPrice, 2)}</strong>
                        <small>{formatDate(trade.exitTime)}</small>
                      </td>
                      <td>{formatNumber(trade.qty, 4)}</td>
                      <td>{formatNumber(trade.pnl, 2)}</td>
                      <td>{trade.reason}</td>
                    </tr>
                  );
                })}
                {!visibleTrades.length && (
                  <tr>
                    <td colSpan="6" className={styles.emptyCell}>No hay trades para este filtro.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.tablePanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Eventos y señales</h2>
              <p>Secuencia de evaluaciones al cierre de cada vela.</p>
            </div>
            <span className={styles.badge}>{result.signals?.length || 0} velas</span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Signal</th>
                  <th>Action</th>
                  <th>Precio</th>
                </tr>
              </thead>
              <tbody>
                {(result.signals || []).slice(-80).reverse().map((item, index) => (
                  <tr key={`${item.closeTime}-${index}`}>
                    <td>{formatDate(item.closeTime)}</td>
                    <td>{item.type}</td>
                    <td>{item.action}</td>
                    <td>{formatNumber(item.price, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className={styles.assumptionsPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>Supuestos de simulacion</h2>
            <p>La corrida usa las mismas reglas de cierre por vela y sizing USD del bot actual.</p>
          </div>
        </div>
        <div className={styles.assumptionsGrid}>
          {Object.entries(result.assumptions || {}).map(([key, value]) => (
            <div key={key} className={styles.assumptionCard}>
              <span>{key}</span>
              <strong>{String(value)}</strong>
            </div>
          ))}
          <div className={styles.assumptionCard}>
            <span>Rango</span>
            <strong>{result.config?.from ? `${toDatetimeLocal(result.config.from)} -> ${toDatetimeLocal(result.config.to)}` : `${result.config?.limit || '—'} velas`}</strong>
          </div>
          <div className={styles.assumptionCard}>
            <span>Estrategia</span>
            <strong>{selectedStrategy?.name || `#${result.config?.strategyId}`}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

export default BacktestResults;
