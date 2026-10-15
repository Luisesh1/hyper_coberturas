import { fmtIv, fmtNum, fmtPrice, fmtStrike } from '../format';
import ExpiryPills from './ExpiryPills';
import styles from './ManualTrading.module.css';

// Índice del strike más cercano al spot (el ATM).
export function atmIndex(rows, spot) {
  const S = Number(spot);
  if (!rows?.length || !Number.isFinite(S)) return -1;
  let best = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.strike - S) < Math.abs(rows[best].strike - S)) best = i;
  });
  return best;
}

function QuoteButton({ leg, kind, strike, type, onPick, picked }) {
  const value = kind === 'bid' ? leg?.bid : leg?.ask;
  const side = kind === 'bid' ? 'SELL' : 'BUY';
  const has = leg?.symbol && Number(value) > 0;
  const label = `${side === 'SELL' ? 'Vender' : 'Comprar'} ${type === 'C' ? 'call' : 'put'} ${fmtStrike(strike)} a ${fmtPrice(value)}`;
  return (
    <button
      type="button"
      className={`${styles.cellBtn} ${side === 'SELL' ? styles.cellSell : styles.cellBuy} ${picked ? styles.cellPicked : ''}`}
      aria-label={label}
      disabled={!has}
      onClick={() => onPick({ leg, strike, type, side })}
    >
      {has ? fmtPrice(value) : '—'}
    </button>
  );
}

// Cadena de escritorio: calls | strike | puts. Clic en Bid = vender,
// en Ask = comprar.
export default function OptionChain({ chain, loading, error, expiry, onExpiry, selection, onPick }) {
  const rows = chain?.rows || [];
  const atm = atmIndex(rows, chain?.spot);
  const spot = Number(chain?.spot);

  const isPicked = (leg, side) => selection?.symbol && leg?.symbol === selection.symbol && selection.side === side;

  return (
    <section aria-label="Cadena de opciones" className={`${styles.card} ${styles.chainCard}`}>
      <div className={styles.chainToolbar}>
        <ExpiryPills expiries={chain?.expiries} value={expiry} onChange={onExpiry} />
        <span className={styles.chainHint}>Clic en Bid para vender · en Ask para comprar</span>
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
                <th>Δ</th><th>IV</th><th>Bid</th><th>Ask</th><th>Interés</th>
                <th className={styles.center}>Strike</th>
                <th>Bid</th><th>Ask</th><th>IV</th><th>Δ</th><th>Interés</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const selected = selection?.symbol && (r.call?.symbol === selection.symbol || r.put?.symbol === selection.symbol);
                const cls = [
                  selected ? styles.rowSelected : '',
                  Number.isFinite(spot) && r.strike < spot ? styles.itmCall : '',
                  Number.isFinite(spot) && r.strike > spot ? styles.itmPut : '',
                ].join(' ');
                return (
                  <tr key={r.strike} className={cls}>
                    <td><span className={styles.plain}>{fmtNum(r.call?.delta, 2)}</span></td>
                    <td><span className={styles.plain}>{fmtIv(r.call?.iv)}</span></td>
                    <td><QuoteButton leg={r.call} kind="bid" strike={r.strike} type="C" onPick={onPick} picked={isPicked(r.call, 'SELL')} /></td>
                    <td><QuoteButton leg={r.call} kind="ask" strike={r.strike} type="C" onPick={onPick} picked={isPicked(r.call, 'BUY')} /></td>
                    <td><span className={styles.plain}>{fmtNum(r.call?.openInterest, 0)}</span></td>
                    <td className={`${styles.strikeCell} ${styles.mono} ${i === atm ? styles.strikeAtm : ''}`}>{fmtStrike(r.strike)}</td>
                    <td><QuoteButton leg={r.put} kind="bid" strike={r.strike} type="P" onPick={onPick} picked={isPicked(r.put, 'SELL')} /></td>
                    <td><QuoteButton leg={r.put} kind="ask" strike={r.strike} type="P" onPick={onPick} picked={isPicked(r.put, 'BUY')} /></td>
                    <td><span className={styles.plain}>{fmtIv(r.put?.iv)}</span></td>
                    <td><span className={styles.plain}>{fmtNum(r.put?.delta, 2)}</span></td>
                    <td><span className={styles.plain}>{fmtNum(r.put?.openInterest, 0)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
