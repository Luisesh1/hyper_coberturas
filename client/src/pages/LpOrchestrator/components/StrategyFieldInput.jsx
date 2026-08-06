import { STRATEGY_FIELD_BY_KEY } from './strategy-fields';
import ui from '../../../styles/modal-controls.module.css';
import styles from './StrategyFieldInput.module.css';

/**
 * Label con tooltip. Vive acá (y no en el wizard) para que el modal de
 * edición muestre las mismas explicaciones: antes solo las tenía el wizard,
 * así que la misma opción se entendía al crear y quedaba a ciegas al editar.
 */
export function FieldLabel({ text, tooltip }) {
  return (
    <label className={`${ui.fieldLabel} ${styles.labelWithTooltip}`}>
      {text}
      {tooltip && (
        <span className={styles.tooltipIcon} title={tooltip} aria-label={tooltip}>
          ⓘ
        </span>
      )}
    </label>
  );
}

/**
 * Campo numérico de estrategia. Toma label, tooltip y rangos de la definición
 * compartida (`strategy-fields.js`), así que los dos formularios no pueden
 * divergir. `hint` deja agregar el texto derivado que solo tiene sentido en
 * un contexto concreto (p. ej. la vista previa del rango en el wizard).
 */
export default function StrategyFieldInput({ fieldKey, value, onChange, hint }) {
  const field = STRATEGY_FIELD_BY_KEY[fieldKey];
  if (!field) return null;

  return (
    <div className={ui.field}>
      <FieldLabel text={field.label} tooltip={field.tooltip} />
      <input
        type="number"
        aria-label={field.label}
        min={field.min}
        max={field.max}
        step={field.step}
        value={value ?? ''}
        onChange={(e) => onChange(fieldKey, e.target.value)}
      />
      {hint && <span className={ui.fieldHint}>{hint}</span>}
    </div>
  );
}
