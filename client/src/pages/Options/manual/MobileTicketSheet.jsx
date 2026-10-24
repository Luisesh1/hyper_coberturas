import { Link } from 'react-router-dom';
import BottomSheet from '../../TradingView/components/BottomSheet';
import { fmtNum, fmtPrice, fmtSigned } from '../format';
import { OrderFlags, QtyHint, QtyUnitToggle, SideSegment, submitLabelOf } from './OrderTicket';
import styles from './ManualTrading.module.css';

function Stepper({ id, label, value, onText, onStep, downLabel, upLabel }) {
  return (
    <div className={styles.stepRow}>
      <span className={styles.stepLabel} id={id}>{label}</span>
      <div className={styles.stepper}>
        <button type="button" className={styles.stepBtn} aria-label={downLabel} onClick={() => onStep(-1)}>−</button>
        <input
          className={styles.stepInput}
          inputMode="decimal"
          aria-labelledby={id}
          value={value}
          onChange={(e) => onText(e.target.value)}
        />
        <button type="button" className={styles.stepBtn} aria-label={upLabel} onClick={() => onStep(1)}>+</button>
      </div>
    </div>
  );
}

// Ticket móvil en hoja inferior: lado, steppers de precio y contratos,
// resumen y CTA a todo el ancho.
export default function MobileTicketSheet({ open, onClose, ticket, configured, pending, onSubmit }) {
  const s = ticket.summary;
  const canSubmit = configured && !!ticket.order && !pending;
  const total = s.valid ? ` · ${fmtNum(Math.abs(s.premium), 2)} USDT` : '';

  return (
    <BottomSheet open={open} title="Nueva orden" onClose={onClose} actionLabel="Cerrar">
      <div className={styles.sheetHead}>
        <span className={`${styles.mono} ${styles.sheetSymbol}`}>{ticket.symbol}</span>
        <span className={`${styles.mono} ${styles.sheetMark}`}>Mark {fmtPrice(ticket.leg?.mark)}</span>
      </div>

      <SideSegment side={ticket.side} onChange={ticket.setSide} />

      <Stepper
        id="opt-ticket-price"
        label="Precio límite"
        value={ticket.priceText}
        onText={ticket.setPriceText}
        onStep={ticket.stepPrice}
        downLabel="Bajar precio"
        upLabel="Subir precio"
      />
      {ticket.priceError && <p className={styles.ticketError} role="alert">{ticket.priceError}</p>}
      <QtyUnitToggle ticket={ticket} className={`${styles.unitToggle} ${styles.unitToggleWide}`} />
      {ticket.qtyUnit === 'USD' ? (
        <Stepper
          id="opt-ticket-usd"
          label="Prima (USD)"
          value={ticket.usdText}
          onText={ticket.setUsdText}
          onStep={ticket.stepQty}
          downLabel="Menos USD"
          upLabel="Más USD"
        />
      ) : (
        <Stepper
          id="opt-ticket-qty"
          label="Contratos"
          value={ticket.qtyText}
          onText={ticket.setQtyText}
          onStep={ticket.stepQty}
          downLabel="Menos contratos"
          upLabel="Más contratos"
        />
      )}
      <QtyHint ticket={ticket} />

      <OrderFlags ticket={ticket} />

      <div className={styles.statGrid}>
        <span className={styles.stat}>Prima<span className={`${styles.mono} ${styles.statValue}`}>{s.valid ? fmtSigned(s.premium, 2) : '—'}</span></span>
        <span className={styles.stat}>Margen<span className={`${styles.mono} ${styles.statValue}`}>{s.margin != null ? fmtNum(s.margin, 0) : '—'}</span></span>
        <span className={styles.stat}>Break-even<span className={`${styles.mono} ${styles.statValue}`}>{s.valid ? fmtPrice(s.breakeven) : '—'}</span></span>
      </div>

      <button
        type="button"
        className={`${styles.mSubmit} ${ticket.side === 'BUY' ? styles.submitBuy : styles.submitSell}`}
        disabled={!canSubmit}
        onClick={() => onSubmit(ticket.order)}
      >
        {pending ? 'Enviando…' : `${submitLabelOf(ticket)}${total}`}
      </button>

      {!configured && (
        <p className={styles.sheetHint}>
          Para enviar órdenes, <Link to="/config?section=binanceOptions">conecta tu API key</Link>.
        </p>
      )}
    </BottomSheet>
  );
}
