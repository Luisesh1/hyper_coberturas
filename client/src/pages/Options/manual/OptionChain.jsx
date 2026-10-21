import { Fragment } from 'react';
import { fmtIv, fmtNum, fmtPrice, fmtSpot, fmtStrike } from '../format';
import ChainBadges, { MarkIcon } from './ChainBadges';
import ExpiryPills from './ExpiryPills';
import { spotDividerIndex } from './MobileChain';
import { optionPremiumLeverage, quoteMid } from './mobileChainMetrics';
import styles from './ManualTrading.module.css';

// Mismo cálculo que la columna «Apal.» de móvil: nocional del subyacente / prima al ask.
function LeverageCell({ spot, leg }) {
  const leverage = optionPremiumLeverage(spot, leg?.ask);
  return <span className={styles.plain}>{leverage == null ? '—' : `${fmtNum(leverage, 1)}x`}</span>;
}

function QuoteButton({ leg, kind, strike, type, onPick, picked }) {
  const value = kind === 'bid' ? leg?.bid : leg?.ask;
  const side = kind === 'bid' ? 'SELL' : 'BUY';
  const has = leg?.symbol && Number(value) > 0;
  const label = `${side === 'SELL' ? 'Vender' : 'Comprar'} ${type === 'C' ? 'call' : 'put'} ${fmtStrike(strike)} a ${fmtPrice(value)}`;
  return (
    <button
      type="button"
      className={`${styles.cellBtn} ${styles.quoteSideBtn} ${side === 'SELL' ? styles.cellSell : styles.cellBuy} ${picked ? styles.cellPicked : ''}`}
      aria-label={label}
      disabled={!has}
      onClick={() => onPick({ leg, strike, type, side })}
    >
      {has ? fmtPrice(value) : '—'}
    </button>
  );
}

// Celda combinada: promedio arriba; bid (vender) y ask (comprar) abajo
// en los laterales, cada uno clicable por separado.
function QuoteCell({ leg, strike, type, onPick, isPicked, mark }) {
  const mid = quoteMid(leg?.bid, leg?.ask);
  const ring = mark?.position ? styles.quoteRingPos : mark?.orders.length ? styles.quoteRingOrd : '';
  return (
    <div className={`${styles.quoteCell} ${ring}`}>
      <span className={styles.quoteMid} title="Promedio entre bid y ask">{mid == null ? '—' : fmtPrice(mid)}</span>
      <QuoteButton leg={leg} kind="bid" strike={strike} type={type} onPick={onPick} picked={isPicked(leg, 'SELL')} />
      <QuoteButton leg={leg} kind="ask" strike={strike} type={type} onPick={onPick} picked={isPicked(leg, 'BUY')} />
    </div>
  );
}

// Cadena de escritorio: calls | strike | puts. Cada lado agrupa
// promedio/bid/ask en una celda: clic en Bid = vender, en Ask = comprar.
// Como en móvil, una línea con el spot en vivo divide la tabla entre strikes.
export default function OptionChain({ chain, loading, error, expiry, onExpiry, selection, onPick, marks = null }) {
  const rows = chain?.rows || [];
  const divider = spotDividerIndex(rows, chain?.spot);
  const spot = Number(chain?.spot);

  const isPicked = (leg, side) => selection?.symbol && leg?.symbol === selection.symbol && selection.side === side;

  return (
    <section aria-label="Cadena de opciones" className={`${styles.card} ${styles.chainCard}`}>
      <div className={styles.chainToolbar}>
        <ExpiryPills expiries={chain?.expiries} value={expiry} onChange={onExpiry} marks={marks?.byExpiry} />
        <span className={styles.chainHint}>
          <span className={styles.itmLegend}><span className={styles.itmSwatch} aria-hidden="true" />Dentro del dinero</span>
          {marks?.bySymbol.size > 0 && (
            <>
              {' · '}<span className={`${styles.badge} ${styles.badgePos}`} aria-hidden="true"><MarkIcon kind="star" /></span> posición
              {' · '}<span className={`${styles.badge} ${styles.badgeBuy}`} aria-hidden="true"><MarkIcon kind="up" /></span>
              <span className={`${styles.badge} ${styles.badgeSell}`} aria-hidden="true"><MarkIcon kind="down" /></span> orden compra / venta
            </>
          )}
          {' · '}Clic en Bid para vender · en Ask para comprar
        </span>
      </div>
      {error && !rows.length ? (
        <p className={styles.empty} role="alert">No se pudo cargar la cadena: {error.message}</p>
      ) : !rows.length ? (
        <p className={styles.empty}>{loading ? 'Cargando cadena…' : 'Sin contratos para este vencimiento.'}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.chain}>
            <thead>
              <tr>
                <th colSpan={5} className={styles.sideCalls}>Calls</th>
                <th className={styles.center} aria-hidden="true" />
                <th colSpan={5} className={styles.sidePuts}>Puts</th>
              </tr>
              <tr>
                <th>Δ</th><th title="Nocional del subyacente / prima al ask (no es apalancamiento delta)">Apal.</th><th>IV</th><th className={styles.quoteHead}>Bid · Prom · Ask</th><th>Interés</th>
                <th className={styles.center}>Strike</th>
                <th className={styles.quoteHead}>Bid · Prom · Ask</th><th>IV</th><th>Δ</th><th title="Nocional del subyacente / prima al ask (no es apalancamiento delta)">Apal.</th><th>Interés</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cMark = r.call?.symbol ? marks?.bySymbol.get(r.call.symbol) : null;
                const pMark = r.put?.symbol ? marks?.bySymbol.get(r.put.symbol) : null;
                const selected = selection?.symbol && (r.call?.symbol === selection.symbol || r.put?.symbol === selection.symbol);
                const cls = [
                  selected ? styles.rowSelected : '',
                  Number.isFinite(spot) && r.strike < spot ? styles.itmCall : '',
                  Number.isFinite(spot) && r.strike > spot ? styles.itmPut : '',
                ].join(' ');
                return (
                  <Fragment key={r.strike}>
                    {i === divider && (
                      <tr className={styles.spotRow}>
                        <td colSpan={11}>
                          <div className={styles.spotDivider}>
                            <span className={`${styles.mono} ${styles.spotDividerLabel}`}>Spot {fmtSpot(chain.spot)}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr className={cls}>
                      <td><span className={styles.plain}>{fmtNum(r.call?.delta, 2)}</span></td>
                      <td><LeverageCell spot={chain?.spot} leg={r.call} /></td>
                      <td><span className={styles.plain}>{fmtIv(r.call?.iv)}</span></td>
                      <td><QuoteCell leg={r.call} strike={r.strike} type="C" onPick={onPick} isPicked={isPicked} mark={cMark} /></td>
                      <td><span className={styles.plain}>{fmtNum(r.call?.openInterest, 0)}</span></td>
                      <td className={`${styles.strikeCell} ${styles.mono}`}>
                        <span className={styles.strikeInner}>
                          <span className={styles.strikeSide}><ChainBadges mark={cMark} /></span>
                          {fmtStrike(r.strike)}
                          <span className={styles.strikeSide}><ChainBadges mark={pMark} reverse /></span>
                        </span>
                      </td>
                      <td><QuoteCell leg={r.put} strike={r.strike} type="P" onPick={onPick} isPicked={isPicked} mark={pMark} /></td>
                      <td><span className={styles.plain}>{fmtIv(r.put?.iv)}</span></td>
                      <td><span className={styles.plain}>{fmtNum(r.put?.delta, 2)}</span></td>
                      <td><LeverageCell spot={chain?.spot} leg={r.put} /></td>
                      <td><span className={styles.plain}>{fmtNum(r.put?.openInterest, 0)}</span></td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
