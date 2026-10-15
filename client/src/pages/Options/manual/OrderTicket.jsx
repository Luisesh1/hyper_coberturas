import { Link } from 'react-router-dom';
import { fmtNum, fmtPrice, fmtSigned } from '../format';
import styles from './ManualTrading.module.css';

export function submitLabelOf(ticket) {
  return `${ticket.side === 'BUY' ? 'Comprar' : 'Vender'} ${ticket.type === 'C' ? 'call' : 'put'}`;
}

export function SideSegment({ side, onChange, className = styles.segment }) {
  return (
    <div role="group" aria-label="Lado" className={className}>
      <button
        type="button"
        className={`${styles.segBtn} ${side === 'BUY' ? styles.segBuyOn : ''}`}
        aria-pressed={side === 'BUY'}
        onClick={() => onChange('BUY')}
      >
        Comprar
      </button>
      <button
        type="button"
        className={`${styles.segBtn} ${side === 'SELL' ? styles.segSellOn : ''}`}
        aria-pressed={side === 'SELL'}
        onClick={() => onChange('SELL')}
      >
        Vender
      </button>
    </div>
  );
}

export function OrderFlags({ ticket }) {
  return (
    <div className={styles.checks}>
      <label className={styles.check}>
        <input type="checkbox" checked={ticket.postOnly} onChange={(e) => ticket.setFlag('postOnly', e.target.checked)} />
        Post-only
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={ticket.reduceOnly} onChange={(e) => ticket.setFlag('reduceOnly', e.target.checked)} />
        Solo reducir
      </label>
    </div>
  );
}

// Ticket de orden límite (escritorio).
export default function OrderTicket({ ticket, configured, pending, onSubmit }) {
  const s = ticket.summary;
  const hasLeg = !!ticket.symbol;
  const canSubmit = configured && !!ticket.order && !pending;

  return (
    <aside aria-label="Ticket de orden" className={`${styles.card} ${styles.ticket}`}>
      <div className={styles.ticketHead}>
        <h2 className={styles.ticketTitle}>Nueva orden</h2>
        {hasLeg && <span className={styles.symbolTag}>{ticket.symbol}</span>}
      </div>

      {!hasLeg ? (
        <p className={styles.footnote}>Elige un precio en la cadena: Bid para vender, Ask para comprar.</p>
      ) : (
        <>
          <SideSegment side={ticket.side} onChange={ticket.setSide} />

          <div className={styles.fields}>
            <label className={styles.field}>
              Precio límite (USDT)
              <input
                className={styles.input}
                inputMode="decimal"
                value={ticket.priceText}
                onChange={(e) => ticket.setPriceText(e.target.value)}
                aria-invalid={ticket.price == null}
              />
            </label>
            <label className={styles.field}>
              Cantidad (contratos)
              <input
                className={styles.input}
                inputMode="decimal"
                value={ticket.qtyText}
                onChange={(e) => ticket.setQtyText(e.target.value)}
                aria-invalid={ticket.qty == null}
              />
            </label>
          </div>

          <OrderFlags ticket={ticket} />

          <dl className={styles.summary}>
            <dt>Prima total</dt>
            <dd className={styles.neutral}>{s.valid ? `${fmtSigned(s.premium, 2)} USDT` : '—'}</dd>
            <dt>Comisión est.</dt>
            <dd>{s.valid ? `${fmtNum(s.fee, 2)} USDT` : '—'}</dd>
            <dt>Margen requerido</dt>
            <dd>{s.margin != null ? `${fmtNum(s.margin, 2)} USDT` : '—'}</dd>
            <dt>Δ / Θ de la orden</dt>
            <dd>{s.valid ? `${fmtSigned(s.delta, 3)} / ${fmtSigned(s.theta, 2)}` : '—'}</dd>
            <dt>Break-even</dt>
            <dd>{s.valid ? fmtPrice(s.breakeven) : '—'}</dd>
          </dl>

          <button
            type="button"
            className={`${styles.submit} ${ticket.side === 'BUY' ? styles.submitBuy : styles.submitSell}`}
            disabled={!canSubmit}
            onClick={() => onSubmit(ticket.order)}
          >
            {pending ? 'Enviando…' : submitLabelOf(ticket)}
          </button>
        </>
      )}

      {!configured && (
        <p className={styles.footnote}>
          Para enviar órdenes, <Link to="/config?section=binanceOptions">conecta tu API key de Binance Opciones</Link>.
        </p>
      )}
      <p className={styles.footnote}>
        Binance Opciones solo acepta órdenes límite. Las opciones son europeas y se liquidan en USDT al vencimiento (08:00 UTC).
      </p>
    </aside>
  );
}
