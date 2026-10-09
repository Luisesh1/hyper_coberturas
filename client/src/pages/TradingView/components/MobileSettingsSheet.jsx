import BottomSheet from './BottomSheet';
import { EyeIcon, EyeOffIcon, RefreshIcon, TrashIcon } from './icons';
import styles from './MobileChrome.module.css';

function Segmented({ label, options, value, onChange }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.segmented} role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={`${styles.segment} ${value === o.value ? styles.segmentActive : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.short || o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Ajustes secundarios del gráfico en móvil: sustituye a los <select> nativos
// que antes empujaban el gráfico hacia abajo.
export default function MobileSettingsSheet({
  open,
  onClose,
  crosshairModes,
  crosshairMode,
  onCrosshairMode,
  priceScaleModes,
  priceScaleMode,
  onPriceScaleMode,
  overlaysHidden,
  onToggleOverlays,
  onRefresh,
  loading,
  candleCount,
  hasDrawings,
  onClearDrawings,
}) {
  return (
    <BottomSheet open={open} title="Ajustes del gráfico" onClose={onClose}>
      <Segmented label="Crosshair" options={crosshairModes} value={crosshairMode} onChange={onCrosshairMode} />
      <Segmented label="Escala de precio" options={priceScaleModes} value={priceScaleMode} onChange={onPriceScaleMode} />
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Vista</span>
        <button type="button" className={styles.rowBtn} onClick={onToggleOverlays} aria-pressed={!overlaysHidden}>
          {overlaysHidden ? <EyeOffIcon /> : <EyeIcon />}
          <span className={styles.rowBtnText}>Leyenda sobre el gráfico</span>
          <span className={styles.rowBtnMeta}>{overlaysHidden ? 'Oculta' : 'Visible'}</span>
        </button>
        <button type="button" className={styles.rowBtn} onClick={onRefresh} disabled={loading}>
          <RefreshIcon />
          <span className={styles.rowBtnText}>{loading ? 'Cargando…' : 'Recargar datos'}</span>
          <span className={styles.rowBtnMeta}>{candleCount} velas</span>
        </button>
        {hasDrawings && (
          <button type="button" className={styles.rowBtn} onClick={onClearDrawings}>
            <TrashIcon />
            <span className={styles.rowBtnText}>Borrar todos los dibujos</span>
          </button>
        )}
      </div>
    </BottomSheet>
  );
}
