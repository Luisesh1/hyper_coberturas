import { formatCompactPrice } from '../../utils/pool-formatters';
import { PRESET_HINTS } from './constants';
import styles from '../SmartCreatePoolModal.module.css';

/**
 * Tarjeta de preset (conservative / balanced / aggressive) para el wizard.
 */
export default function PresetCard({ preset, selected, onClick }) {
  return (
    <div
      className={`${styles.presetCard} ${selected ? styles.presetCardSelected : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick();
      }}
    >
      <h4>{preset.label}</h4>
      <div className={styles.presetInfo}>
        <div className={styles.infoRow}>
          <span>Rango</span>
          <strong>${formatCompactPrice(preset.rangeLowerPrice)} — ${formatCompactPrice(preset.rangeUpperPrice)}</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Ancho</span>
          <strong>±{preset.widthPct.toFixed(1)}%</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Token0</span>
          <strong>{preset.targetWeightToken0Pct.toFixed(1)}%</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Token1</span>
          <strong>{(100 - preset.targetWeightToken0Pct).toFixed(1)}%</strong>
        </div>
      </div>
      <p className={styles.hint}>{PRESET_HINTS[preset.preset]}</p>
    </div>
  );
}
