import { useState } from 'react';
import { Link } from 'react-router-dom';
import CloseAtPriceForm from './CloseAtPriceForm';
import BottomSheet from '../../TradingView/components/BottomSheet';
import { useSwipeToReveal } from '../../TradingView/components/useSwipeToReveal';
import { fmtDateTime, fmtNum, fmtPrice, fmtSigned, toneOf } from '../format';
import { orderView, positionView, sideLabel, tradeView } from './accountRows';
import styles from './ManualTrading.module.css';

// Ancho del botón revelado (debe coincidir con .swipeAction).
const REVEAL_WIDTH = 96;

const SECTIONS = [
  { key: 'positions', label: 'Posiciones' },
  { key: 'orders', label: 'Órdenes' },
  { key: 'history', label: 'Historial' },
];

// Fila de tarjeta con «deslizar a la izquierda» para la acción destructiva.
// El botón visible queda como alternativa sin gesto.
function SwipeCard({ id, swipe, actionLabel, actionAria, onAction, disabled, children }) {
  const open = swipe.openId === id;
  const handlers = swipe.bind(id);
  const offset = swipe.offsetFor(id);
  return (
    <div className={styles.swipeRow}>
      <button
        type="button"
        className={styles.swipeAction}
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        disabled={disabled}
        aria-label={actionAria}
        onClick={() => { swipe.close(); onAction(); }}
      >
        {actionLabel}
      </button>
      <div
        className={`${styles.swipeTrack} ${swipe.isDragging(id) ? styles.swipeTrackDragging : ''}`}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={(e) => { if (!e.target.closest?.('button, input, label')) handlers.onPointerDown(e); }}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onClick={() => swipe.shouldSuppressClick()}
      >
        {children}
      </div>
    </div>
  );
}

export default function MobilePositionsSheet({
  open, onClose, section, onSection, configured, account, positions, openOrders, trades, tradesLoading,
  pending, onClosePosition, onCloseAtPrice, onCancelOrder,
}) {
  const swipe = useSwipeToReveal({ revealWidth: REVEAL_WIDTH, enabled: open });
  const [editingSymbol, setEditingSymbol] = useState(null);
  const [expandedTrade, setExpandedTrade] = useState(null);
  const g = account?.greeks || {};
  const counts = { positions: positions.length, orders: openOrders.length, history: null };

  return (
    <BottomSheet open={open} title="Cartera" onClose={onClose}>
      {!configured ? (
        <p className={styles.empty}>
          Conecta tu API key en <Link to="/config?section=binanceOptions">Configuración › Binance Opciones</Link> para ver tu cartera.
        </p>
      ) : (
        <>
          <div className={styles.greeksRow} aria-label="Griegas de la cartera">
            <span>Δ<span className={`${styles.mono} ${styles.neutral}`}>{fmtSigned(g.delta, 3)}</span></span>
            <span>Γ<span className={`${styles.mono} ${styles.neutral}`}>{fmtSigned(g.gamma, 3)}</span></span>
            <span>Θ/día<span className={`${styles.mono} ${styles[toneOf(g.theta)]}`}>{fmtSigned(g.theta, 2)}</span></span>
            <span>Vega<span className={`${styles.mono} ${styles.neutral}`}>{fmtSigned(g.vega, 1)}</span></span>
          </div>

          <div role="tablist" aria-label="Detalle de la cuenta" className={styles.sheetSeg}>
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={section === s.key}
                className={`${styles.sheetSegBtn} ${section === s.key ? styles.sheetSegOn : ''}`}
                onClick={() => { swipe.close(); setEditingSymbol(null); onSection(s.key); }}
              >
                {s.label}{counts[s.key] != null ? ` · ${counts[s.key]}` : ''}
              </button>
            ))}
          </div>

          {section === 'positions' && (
            positions.length === 0 ? <p className={styles.empty}>Sin posiciones abiertas.</p> : (
              <>
                <div className={styles.cardList}>
                  {positions.map((raw) => {
                    const p = positionView(raw);
                    return (
                      <SwipeCard
                        key={p.key}
                        id={p.key}
                        swipe={swipe}
                        actionLabel="Cerrar"
                        actionAria={`Cerrar ${p.symbol} (deslizar)`}
                        disabled={pending}
                        onAction={() => onClosePosition(raw)}
                      >
                        <div className={styles.posCardBlock}>
                          <div className={styles.posCard}>
                            <span className={styles.posText}>
                              <span className={`${styles.mono} ${styles.posSymbol}`}>{p.symbol}</span>
                              <span className={styles.posMeta}>{p.side} {fmtNum(p.qty, 2)} · {p.origin}</span>
                              <span className={styles.posMeta}>Entrada: {fmtPrice(p.entry)} USDT/contrato</span>
                              <span className={styles.posMeta}>Mark: {fmtPrice(p.mark)} USDT/contrato</span>
                              <span className={styles.posPremium}>
                                Prima actual: <strong className={styles.mono}>
                                  {p.premiumCurrent == null ? '—' : `${fmtNum(p.premiumCurrent, 2)} USDT`}
                                </strong>
                              </span>
                            </span>
                            <span className={`${styles.posRight} ${styles.posRightColumn}`}>
                              <span className={`${styles.mono} ${styles.posPnl} ${styles[toneOf(p.pnl)]}`}>{fmtSigned(p.pnl, 2)}</span>
                              <button
                                type="button"
                                className={styles.posBtn}
                                disabled={pending}
                                aria-label={`Cerrar ${p.symbol}`}
                                onClick={() => onClosePosition(raw)}
                              >
                                Cerrar
                              </button>
                              <button
                                type="button"
                                className={`${styles.posBtn} ${styles.posTargetBtn}`}
                                disabled={pending}
                                aria-expanded={editingSymbol === p.key}
                                aria-label={`Cerrar a precio ${p.symbol}`}
                                onClick={() => setEditingSymbol(editingSymbol === p.key ? null : p.key)}
                              >
                                Cerrar a precio
                              </button>
                            </span>
                          </div>
                          {editingSymbol === p.key && (
                            <CloseAtPriceForm
                              position={raw}
                              pending={pending}
                              onSubmit={onCloseAtPrice}
                              onCancel={() => setEditingSymbol(null)}
                            />
                          )}
                        </div>
                      </SwipeCard>
                    );
                  })}
                </div>
                <p className={styles.sheetHint}>Desliza una posición a la izquierda para cerrarla</p>
              </>
            )
          )}

          {section === 'orders' && (
            openOrders.length === 0 ? <p className={styles.empty}>Sin órdenes abiertas.</p> : (
              <div className={styles.cardList}>
                {openOrders.map((raw) => {
                  const o = orderView(raw);
                  return (
                    <SwipeCard
                      key={o.key}
                      id={o.key}
                      swipe={swipe}
                      actionLabel="Cancelar"
                      actionAria={`Cancelar orden ${o.symbol} (deslizar)`}
                      disabled={pending}
                      onAction={() => onCancelOrder(o)}
                    >
                      <div className={styles.posCard}>
                        <span className={styles.posText}>
                          <span className={`${styles.mono} ${styles.posSymbol}`}>{o.symbol}</span>
                          <span className={styles.posMeta}>{sideLabel(o.side)} {fmtNum(o.qty, 2)} a {fmtPrice(o.price)} · ejecutado {fmtNum(o.filled, 2)}</span>
                        </span>
                        <span className={styles.posRight}>
                          <button
                            type="button"
                            className={`${styles.posBtn} ${styles.posBtnDanger}`}
                            disabled={pending}
                            aria-label={`Cancelar orden ${o.symbol}`}
                            onClick={() => onCancelOrder(o)}
                          >
                            Cancelar
                          </button>
                        </span>
                      </div>
                    </SwipeCard>
                  );
                })}
              </div>
            )
          )}

          {section === 'history' && (
            trades.length === 0 ? (
              <p className={styles.empty}>{tradesLoading ? 'Cargando historial…' : 'Sin ejecuciones en los últimos 30 días.'}</p>
            ) : (
              <div className={styles.cardList}>
                {trades.map((raw, i) => {
                  const t = tradeView(raw, i);
                  const expanded = expandedTrade === t.key;
                  return (
                    <div key={t.key} className={`${styles.swipeTrack} ${styles.tradeCard}`}>
                      <button
                        type="button"
                        className={`${styles.posCard} ${styles.tradeToggle}`}
                        aria-expanded={expanded}
                        aria-controls={`trade-detail-${i}`}
                        onClick={() => setExpandedTrade(expanded ? null : t.key)}
                      >
                        <span className={styles.posText}>
                          <span className={`${styles.mono} ${styles.posSymbol}`}>{t.symbol}</span>
                          <span className={styles.posMeta}>{sideLabel(t.side)} {fmtNum(t.qty, 2)} a {fmtPrice(t.price)} · {fmtDateTime(t.time)}</span>
                        </span>
                        <span className={styles.posRight}>
                          <span className={`${styles.mono} ${styles.posPnl} ${styles[toneOf(t.pnl)]}`}>{fmtSigned(t.pnl, 2)}</span>
                          <span className={`${styles.tradeChevron} ${expanded ? styles.tradeChevronOpen : ''}`} aria-hidden="true">▾</span>
                        </span>
                      </button>
                      {expanded && (
                        <dl id={`trade-detail-${i}`} className={styles.tradeDetail}>
                          <dt>Fecha</dt><dd className={styles.mono}>{fmtDateTime(t.time)}</dd>
                          <dt>Lado</dt><dd className={t.side === 'BUY' ? styles.up : styles.down}>{t.side === 'BUY' ? 'Compra' : 'Venta'}</dd>
                          <dt>Precio</dt><dd className={styles.mono}>{fmtPrice(t.price)} USDT</dd>
                          <dt>Cantidad</dt><dd className={styles.mono}>{fmtNum(t.qty, 2)}</dd>
                          <dt>{t.side === 'BUY' ? 'Prima pagada' : 'Prima cobrada'}</dt><dd className={styles.mono}>{t.premiumTotal == null ? '—' : `${fmtNum(t.premiumTotal, 2)} USDT`}</dd>
                          <dt>Comisión</dt><dd className={styles.mono}>{fmtNum(t.fee, 4)}</dd>
                          <dt>P&amp;L realizado</dt><dd className={`${styles.mono} ${styles[toneOf(t.pnl)]}`}>{fmtSigned(t.pnl, 2)}</dd>
                        </dl>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </>
      )}
    </BottomSheet>
  );
}
