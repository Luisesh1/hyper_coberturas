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

// Unidad en la que se escribe la cantidad: prima en USD o contratos.
export function QtyUnitToggle({ ticket, className = styles.unitToggle }) {
  return (
    <div role="group" aria-label="Unidad de cantidad" className={className}>
      {[['USD', 'USD'], ['CONTRACTS', 'Contratos']].map(([unit, label]) => (
        <button
          key={unit}
          type="button"
          className={`${styles.unitBtn} ${ticket.qtyUnit === unit ? styles.unitOn : ''}`}
          aria-pressed={ticket.qtyUnit === unit}
          onClick={() => ticket.setQtyUnit(unit)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Cálculo aproximado de la cantidad en la otra unidad. En USD dice cuántos
// contratos (ya redondeados) se enviarán y la prima real resultante.
export function QtyHint({ ticket }) {
  if (ticket.qtyError) return <p className={styles.ticketError} role="alert">{ticket.qtyError}</p>;
  const { qty, price } = ticket;
  const ok = Number.isFinite(qty) && qty > 0 && Number.isFinite(price) && price > 0;
  const text = !ok
    ? '—'
    : ticket.qtyUnit === 'USD'
      ? `≈ ${fmtNum(qty, 2)} contratos · prima ${fmtNum(qty * price, 2)} USDT`
      : `≈ ${fmtNum(qty * price, 2)} USDT de prima`;
  return <p className={`${styles.qtyHint} ${styles.mono}`} aria-live="polite">{text}</p>;
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
  const usdMode = ticket.qtyUnit === 'USD';

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
                aria-invalid={ticket.price == null || !!ticket.priceError}
              />
            </label>
            <div className={styles.field}>
              <div className={styles.fieldHead}>
                <span>Cantidad</span>
                <QtyUnitToggle ticket={ticket} />
              </div>
              <input
                className={styles.input}
                inputMode="decimal"
                aria-label={usdMode ? 'Cantidad (USD)' : 'Cantidad (contratos)'}
                value={usdMode ? ticket.usdText : ticket.qtyText}
                onChange={(e) => (usdMode ? ticket.setUsdText : ticket.setQtyText)(e.target.value)}
                aria-invalid={!ticket.qty}
              />
            </div>
          </div>
          {ticket.priceError && <p className={styles.ticketError} role="alert">{ticket.priceError}</p>}
          <QtyHint ticket={ticket} />

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
