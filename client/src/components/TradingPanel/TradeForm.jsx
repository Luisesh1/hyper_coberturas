/**
 * TradeForm.jsx — Left column: form to open positions
 */

import styles from './TradingPanel.module.css';

export function TradeForm({
  side,
  setSide,
  marginMode,
  setMarginMode,
  leverage,
  setLeverage,
  denomination,
  setDenomination,
  size,
  setSize,
  asset,
  currentPrice,
  sizeInAsset,
  notional,
  requiredMargin,
  availableMargin,
  hasInsufficientMargin,
  isSubmitting,
  selectedAccountId,
  priceUnavailable,
  onSubmit,
}) {
  return (
    <form className={styles.formCol} onSubmit={onSubmit}>
      <div className={styles.colLabel}>Abrir posicion</div>

      <div className={styles.sideRow}>
        <button type="button" className={`${styles.sideBtn} ${side === 'long'  ? styles.longActive  : ''}`} onClick={() => setSide('long')}>▲ Long</button>
        <button type="button" className={`${styles.sideBtn} ${side === 'short' ? styles.shortActive : ''}`} onClick={() => setSide('short')}>▼ Short</button>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Tipo de margen</span>
        <div className={styles.segmented}>
          {['cross', 'isolated'].map((m) => (
            <button key={m} type="button" className={`${styles.segBtn} ${marginMode === m ? styles.segActive : ''}`} onClick={() => setMarginMode(m)}>
              {m === 'cross' ? 'Cross' : 'Isolated'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.label}>Apalancamiento</span>
          <span className={styles.leverageValue}>{leverage}x</span>
        </div>
        <input type="range" min="1" max="50" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className={styles.slider} />
        <div className={styles.leveragePresets}>
          {[1, 2, 5, 10, 20, 50].map((v) => (
            <button key={v} type="button" className={`${styles.preset} ${leverage === v ? styles.presetActive : ''}`} onClick={() => setLeverage(v)}>{v}x</button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.label}>Cantidad ({denomination})</span>
          <div className={styles.denomToggle}>
            {['USDC', asset].map((d) => (
              <button key={d} type="button" className={`${styles.denomBtn} ${denomination === d ? styles.denomActive : ''}`} onClick={() => { setDenomination(d); setSize(''); }}>{d}</button>
            ))}
          </div>
        </div>
        <input
          className={styles.input}
          type="number"
          step={denomination === 'USDC' ? '0.01' : '0.0001'}
          min={denomination === 'USDC' ? '0.01' : '0.0001'}
          placeholder={denomination === 'USDC' ? 'ej: 100' : 'ej: 0.001'}
          value={size}
          onChange={(e) => setSize(e.target.value)}
          required
        />
      </div>

      {notional !== null && (
        <div className={styles.summary}>
          {denomination === 'USDC' && sizeInAsset > 0 && (
            <div className={styles.summaryRow}>
              <span>En {asset}</span>
              <span>{sizeInAsset.toFixed(6)}</span>
            </div>
          )}
          <div className={styles.summaryRow}>
            <span>Nocional</span>
            <span>${notional.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
          </div>
          <div className={`${styles.summaryRow} ${hasInsufficientMargin ? styles.danger : ''}`}>
            <span>Margen req / disp</span>
            <span>${requiredMargin.toFixed(2)} / ${availableMargin.toFixed(2)}</span>
          </div>
        </div>
      )}

      <button type="submit" className={`${styles.submitBtn} ${side === 'long' ? styles.longBtn : styles.shortBtn}`}
        disabled={isSubmitting || !selectedAccountId || !size || !currentPrice || hasInsufficientMargin || priceUnavailable}>
        {isSubmitting ? 'Enviando...' : `${side === 'long' ? '▲ Long' : '▼ Short'} ${asset} a mercado`}
      </button>

      {!selectedAccountId && <p className={styles.warn}>Configura o selecciona una cuenta para operar.</p>}
      {!currentPrice && <p className={styles.warn}>Esperando precio...</p>}
      {hasInsufficientMargin && (
        <p className={styles.warn} style={{ color: '#ef4444' }}>Margen insuficiente: req ${requiredMargin.toFixed(2)}</p>
      )}
    </form>
  );
}
