/**
 * SLTPModal.jsx — Stop-loss / Take-profit modal dialog
 */

import styles from './TradingPanel.module.css';

export function SLTPModal({
  sltpPos,
  slPrice,
  setSlPrice,
  tpPrice,
  setTpPrice,
  sltpSubmitting,
  sltpError,
  onSubmit,
  onClose,
}) {
  if (!sltpPos) return null;

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <form className={styles.modalBox} onClick={(e) => e.stopPropagation()} onSubmit={onSubmit} role="dialog" aria-modal="true" aria-label="Configurar SL/TP">
        <div className={styles.modalHeader}>
          <span>SL / TP — {sltpPos.asset} {sltpPos.side === 'long' ? '▲ Long' : '▼ Short'}</span>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Stop Loss (precio trigger)</span>
          <input
            className={styles.input}
            type="number"
            step="0.01"
            min="0.01"
            placeholder="ej: 90000"
            value={slPrice}
            onChange={(e) => setSlPrice(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Take Profit (precio trigger)</span>
          <input
            className={styles.input}
            type="number"
            step="0.01"
            min="0.01"
            placeholder="ej: 105000"
            value={tpPrice}
            onChange={(e) => setTpPrice(e.target.value)}
          />
        </div>
        {sltpError && <p className={styles.warn} style={{ color: '#ef4444' }}>{sltpError}</p>}
        <button
          type="submit"
          className={styles.submitBtn}
          disabled={sltpSubmitting || (!slPrice && !tpPrice)}
        >
          {sltpSubmitting ? 'Enviando...' : 'Confirmar SL/TP'}
        </button>
      </form>
    </div>
  );
}
