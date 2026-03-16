/**
 * HedgePanel shared constants and utility functions.
 */

export const STATUS_LABEL = {
  entry_pending:   { text: 'Orden GTC activa', color: '#f59e0b' },
  entry_filled_pending_sl: { text: 'Proteccion pendiente', color: '#f97316' },
  open_protected:  { text: 'Posicion protegida', color: '#22c55e' },
  open:            { text: 'Posicion abierta', color: '#22c55e' },
  closing:         { text: 'Cerrando SL...',   color: '#818cf8' },
  cancel_pending:  { text: 'Cancelando...',    color: '#94a3b8' },
  cancelled:       { text: 'Cancelada',        color: '#64748b' },
  error:           { text: 'Error',            color: '#ef4444' },
  // legacy
  waiting:         { text: 'Esperando',        color: '#f59e0b' },
  executing_open:  { text: 'Abriendo...',      color: '#818cf8' },
  executing_close: { text: 'Cerrando...',      color: '#818cf8' },
};

export function loadPct(username) {
  const raw = localStorage.getItem(`hedge_autoexit_pct_${username}`);
  const n   = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}

export function fmt(n, decimals = 4) {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals);
}

/** Calcula PnL bruto, fees, funding y neto de un ciclo */
export function calcCyclePnl(c, hedgeSize, direction) {
  // Preferir closedPnl del exchange (ya incluye slippage real)
  const gross = c.closedPnl != null
    ? c.closedPnl
    : (c.openPrice && c.closePrice
        ? (direction === 'long'
            ? (parseFloat(c.closePrice) - parseFloat(c.openPrice)) * parseFloat(hedgeSize)
            : (parseFloat(c.openPrice)  - parseFloat(c.closePrice)) * parseFloat(hedgeSize))
        : null);
  const fees    = (c.entryFee || 0) + (c.exitFee || 0);
  const funding = c.fundingPaid || 0;                // positivo = recibido
  // Usar netPnl precalculado del backend si esta disponible (incluye datos reales del exchange)
  const net = c.netPnl != null ? c.netPnl : (gross != null ? gross - fees + funding : null);
  return { gross, fees, funding, net };
}
