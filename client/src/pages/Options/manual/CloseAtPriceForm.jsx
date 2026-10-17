import { useState } from 'react';
import { fmtNum, fmtPrice } from '../format';
import { isLongPosition } from './hooks/useOrderActions';
import styles from './ManualTrading.module.css';

export function parseClosePrice(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text)) return null;
  const price = Number(text.replace(',', '.'));
  return Number.isFinite(price) && price > 0 ? price : null;
}

// Una orden LIMIT GTC espera precio igual o mejor. NO es un stop condicional.
export default function CloseAtPriceForm({ position, pending, onSubmit, onCancel }) {
  const [priceText, setPriceText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const side = isLongPosition(position) ? 'Vender' : 'Comprar';
  const quantity = Math.abs(Number(position.quantity));

  const submit = async (event) => {
    event.preventDefault();
    const price = parseClosePrice(priceText);
    if (price == null) {
      setError('Escribe un precio objetivo válido y mayor que cero.');
      return;
    }
    if (!(Number.isFinite(quantity) && quantity > 0)) {
      setError('La cantidad de la posición no es válida.');
      return;
    }
    setBusy(true);
    try {
      const submitted = await onSubmit(position, price);
      if (submitted) onCancel();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.closeAtPriceForm} onSubmit={submit}>
      <label className={styles.closeAtPriceLabel}>
        Precio límite de cierre (USDT por contrato)
        <input
          type="text"
          inputMode="decimal"
          className={styles.closeAtPriceInput}
          aria-label={`Precio objetivo para ${position.symbol}`}
          placeholder={`Mark actual: ${fmtPrice(position.markPrice)}`}
          value={priceText}
          onChange={(event) => { setPriceText(event.target.value); setError(''); }}
        />
      </label>
      <p className={styles.closeAtPricePreview}>
        {side} {fmtNum(quantity, 2)} contratos · Total al precio indicado:{' '}
        <strong>{parseClosePrice(priceText) == null ? '—' : `${fmtNum(parseClosePrice(priceText) * quantity, 2)} USDT`}</strong>
      </p>
      {error && <p className={styles.closeAtPriceError} role="alert">{error}</p>}
      <p className={styles.closeAtPriceNote}>
        Orden límite GTC solo-reducir: puede ejecutarse inmediatamente si el mercado ya ofrece ese precio o uno mejor.
        No es un stop-loss.
      </p>
      <div className={styles.closeAtPriceActions}>
        <button type="button" className={styles.closeAtPriceCancel} onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" className={styles.closeAtPriceSubmit} disabled={pending || busy}>
          {pending || busy ? 'Procesando…' : 'Revisar orden de cierre'}
        </button>
      </div>
    </form>
  );
}
