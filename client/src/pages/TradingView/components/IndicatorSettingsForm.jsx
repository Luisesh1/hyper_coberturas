import { INDICATORS } from '../indicators/catalog';
import styles from './IndicatorConfigModal.module.css';

export default function IndicatorSettingsForm({ indicator, onChange }) {
  if (!indicator) return null;
  const meta = INDICATORS[indicator.type];
  if (!meta) return null;

  const updateParam = (key, value) => {
    onChange({ ...indicator, params: { ...indicator.params, [key]: value } });
  };
  const updateStyle = (key, value) => {
    onChange({ ...indicator, style: { ...indicator.style, [key]: value } });
  };

  return (
    <div className={styles.form}>
      <div className={styles.formHeader}>
        <div>
          <div className={styles.formTitle}>{meta.label}</div>
          <div className={styles.formType}>{meta.fullName}</div>
        </div>
      </div>

      {(meta.paramSchema || []).map((spec) => {
        const value = indicator.params?.[spec.key] ?? meta.defaultParams[spec.key];
        if (spec.type === 'number') {
          return (
            <div key={spec.key} className={styles.formRow}>
              <label className={styles.formLabel}>{spec.label}</label>
              <input
                type="number"
                className={styles.formInput}
                value={value}
                min={spec.min}
                max={spec.max}
                step={spec.step || 1}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  const num = Number(raw);
                  if (!Number.isFinite(num)) return;
                  updateParam(spec.key, num);
                }}
              />
            </div>
          );
        }
        if (spec.type === 'boolean') {
          return (
            <div key={spec.key} className={styles.formRow}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={!!value}
                  onChange={(e) => updateParam(spec.key, e.target.checked)}
                />
                {spec.label}
              </label>
            </div>
          );
        }
        return null;
      })}

      {meta.pane === 'overlay' && (
        <>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Color</label>
            <div className={styles.formInputRow}>
              <input
                type="color"
                className={styles.colorInput}
                value={indicator.style?.color || meta.defaultStyle.color || '#60a5fa'}
                onChange={(e) => updateStyle('color', e.target.value)}
              />
              <input
                type="text"
                className={styles.formInput}
                value={indicator.style?.color || meta.defaultStyle.color || '#60a5fa'}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) updateStyle('color', v);
                }}
              />
            </div>
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Grosor de línea</label>
            <select
              className={styles.formInput}
              value={indicator.style?.lineWidth || meta.defaultStyle.lineWidth || 2}
              onChange={(e) => updateStyle('lineWidth', Number(e.target.value))}
            >
              <option value={1}>Fino (1px)</option>
              <option value={2}>Normal (2px)</option>
              <option value={3}>Grueso (3px)</option>
              <option value={4}>Muy grueso (4px)</option>
            </select>
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Estilo</label>
            <select
              className={styles.formInput}
              value={indicator.style?.lineStyle || 'solid'}
              onChange={(e) => updateStyle('lineStyle', e.target.value)}
            >
              <option value="solid">Continua</option>
              <option value="dashed">Discontinua</option>
              <option value="dotted">Punteada</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}
