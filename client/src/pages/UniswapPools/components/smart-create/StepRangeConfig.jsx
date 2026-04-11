import { formatCompactPrice } from '../../utils/pool-formatters';
import { formatNumber } from '../../../../utils/formatters';
import { formatUsd } from '../../utils/pool-formatters';
import PresetCard from './PresetCard';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Paso 2: Rango y composición (presets ATR o personalizado).
 */
export default function StepRangeConfig({
  suggestions,
  totalUsdTarget,
  rangeMode,
  setRangeMode,
  selectedPreset,
  setSelectedPreset,
  customLowerPrice,
  setCustomLowerPrice,
  customUpperPrice,
  setCustomUpperPrice,
  customWeightToken0,
  setCustomWeightToken0,
  activeRange,
  error,
  handleReset,
  handleContinueToFunding,
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.kicker}>Paso 2: Rango y composición</span>
      </div>

      <div className={styles.balanceRow}>
        <span>Precio actual: {formatNumber(suggestions.currentPrice, 4)}</span>
        <span>ATR 14h: {suggestions.atr14 ? formatNumber(suggestions.atr14, 4) : 'Fallback %'}</span>
        <span>Tick spacing: {suggestions.tickSpacing}</span>
        <span>Valor objetivo: {formatUsd(Number(totalUsdTarget || 0))}</span>
      </div>

      <div className={styles.modeToggle}>
        <button
          type="button"
          className={`${styles.modeBtn} ${rangeMode === 'auto' ? styles.modeBtnActive : ''}`}
          onClick={() => setRangeMode('auto')}
        >
          Auto por ATR
        </button>
        <button
          type="button"
          className={`${styles.modeBtn} ${rangeMode === 'custom' ? styles.modeBtnActive : ''}`}
          onClick={() => setRangeMode('custom')}
        >
          Personalizado
        </button>
      </div>

      {rangeMode === 'auto' && (
        <div className={styles.presetsGrid}>
          {suggestions.suggestions.map((item) => (
            <PresetCard
              key={item.preset}
              preset={item}
              selected={selectedPreset === item.preset}
              onClick={() => setSelectedPreset(item.preset)}
            />
          ))}
        </div>
      )}

      {rangeMode === 'custom' && (
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Precio inferior</span>
            <input type="number" value={customLowerPrice} onChange={(event) => setCustomLowerPrice(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Precio superior</span>
            <input type="number" value={customUpperPrice} onChange={(event) => setCustomUpperPrice(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Balance objetivo Token 0 (%)</span>
            <input type="number" value={customWeightToken0} min="1" max="99" onChange={(event) => setCustomWeightToken0(event.target.value)} />
          </label>
        </div>
      )}

      {activeRange && (
        <div className={styles.summaryGrid}>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Rango final</span>
            <strong className={styles.tileValue}>
              ${formatCompactPrice(activeRange.rangeLowerPrice)} — ${formatCompactPrice(activeRange.rangeUpperPrice)}
            </strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Token 0</span>
            <strong className={styles.tileValue}>{formatNumber(activeRange.targetWeightToken0Pct, 1)}%</strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Token 1</span>
            <strong className={styles.tileValue}>{formatNumber(100 - activeRange.targetWeightToken0Pct, 1)}%</strong>
          </div>
          <div className={styles.summaryTile}>
            <span className={styles.tileLabel}>Montos estimados</span>
            <strong className={styles.tileValue}>
              {formatNumber(Number(activeRange.amount0Desired || 0), 4)} / {formatNumber(Number(activeRange.amount1Desired || 0), 4)}
            </strong>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.buttonGroup}>
        <button type="button" className={styles.secondaryBtn} onClick={handleReset}>
          ← Volver
        </button>
        <button type="button" className={styles.primaryBtn} onClick={handleContinueToFunding}>
          Continuar a fondeo
        </button>
      </div>
    </section>
  );
}
