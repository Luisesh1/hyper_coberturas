import { useId, useState } from 'react';
import { normalizeNumber, parseNumberInput, stepNumber } from '../../../TradingView/components/stepperMath';
import { effectiveStep } from './paramSchema';
import { MinusIcon, PlusIcon } from './icons';
import styles from './Fields.module.css';

// Controles táctiles de formulario (filas de 56px en el teléfono, botones de
// 44px, texto de 16px para que iOS no haga zoom). Siguen el patrón del
// formulario de ajustes de indicadores de TradingView.

export function FieldGroup({ title, children }) {
  const id = useId();
  return (
    <div className={styles.group} role="group" aria-labelledby={id}>
      <div id={id} className={styles.groupLabel}>{title}</div>
      <div className={styles.card}>{children}</div>
    </div>
  );
}

function RowText({ label, help, error, htmlFor, id }) {
  return (
    <span className={styles.rowText}>
      {htmlFor
        ? <label htmlFor={htmlFor} className={styles.rowLabel}>{label}</label>
        : <span id={id} className={styles.rowLabel}>{label}</span>}
      {help && <span className={styles.rowHelp}>{help}</span>}
      {error && <span className={styles.rowError} role="alert">{error}</span>}
    </span>
  );
}

// Stepper − [valor] +. Mientras se escribe se guarda un borrador (para
// permitir '1,' camino de '1,5'); sólo se limita y redondea al confirmar.
export function NumberField({ label, help, unit, value, min, max, step, integer = false, error, onChange, disabled = false }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const current = Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : null;
  const spec = { min, max, step: effectiveStep({ step: integer ? (step || 1) : step, min, max }, current) };

  const commit = (n) => {
    setDraft(null);
    if (n !== current) onChange(n);
  };

  const confirmDraft = () => {
    if (draft === null) return;
    const parsed = parseNumberInput(draft);
    if (parsed === null) {
      setDraft(null);
      if (draft.trim() === '') onChange(null);
      return;
    }
    commit(normalizeNumber(parsed, spec));
  };

  const bump = (direction) => commit(stepNumber(current ?? (Number.isFinite(min) ? min : 0), direction, spec));

  const handleChange = (e) => {
    const raw = e.target.value;
    setDraft(raw);
    const parsed = parseNumberInput(raw);
    const inRange = parsed !== null
      && !(Number.isFinite(min) && parsed < min)
      && !(Number.isFinite(max) && parsed > max);
    if (inRange && parsed !== current) onChange(parsed);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmDraft();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      bump(e.key === 'ArrowUp' ? 1 : -1);
    }
  };

  const atMin = current !== null && Number.isFinite(min) && current <= min;
  const atMax = current !== null && Number.isFinite(max) && current >= max;
  const shown = draft ?? (current === null ? '' : String(current).replace('.', ','));

  return (
    <div className={`${styles.row} ${error ? styles.rowInvalid : ''}`}>
      <RowText label={label} help={help} error={error} htmlFor={id} />
      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => bump(-1)}
          disabled={disabled || atMin}
          aria-label={`Disminuir ${label}`}
        >
          <MinusIcon size={18} />
        </button>
        <span className={styles.stepValue}>
          <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className={styles.stepInput}
            value={shown}
            onChange={handleChange}
            onBlur={confirmDraft}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-invalid={error ? 'true' : undefined}
          />
          {unit && <span className={styles.unit} aria-hidden="true">{unit}</span>}
        </span>
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => bump(1)}
          disabled={disabled || atMax}
          aria-label={`Aumentar ${label}`}
        >
          <PlusIcon size={18} />
        </button>
      </div>
    </div>
  );
}

// Fila entera pulsable: el nombre accesible del switch es su texto.
export function SwitchField({ label, help, checked, onChange, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      className={`${styles.row} ${styles.switchRow}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {help && <span className={styles.rowHelp}>{help}</span>}
      </span>
      <span className={`${styles.track} ${checked ? styles.trackOn : ''}`} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}

// Hasta 4 opciones (o con `columns`, en rejilla): control segmentado. Más:
// select nativo (la rueda del sistema es la mejor UX para listas largas).
export function ChoiceField({ label, help, options, value, onChange, error, columns, disabled = false }) {
  const id = useId();
  if (options.length <= 4 || columns) {
    return (
      <div className={`${styles.row} ${styles.rowStacked}`}>
        <RowText label={label} help={help} error={error} id={id} />
        <div
          className={`${styles.segmented} ${columns ? styles.segmentedGrid : ''}`}
          style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
          role="radiogroup"
          aria-labelledby={id}
        >
          {options.map((opt) => {
            const active = String(opt.value) === String(value);
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="radio"
                aria-checked={active}
                className={`${styles.segment} ${active ? styles.segmentActive : ''}`}
                onClick={() => onChange(opt.value)}
                disabled={disabled || opt.disabled}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className={`${styles.row} ${error ? styles.rowInvalid : ''}`}>
      <RowText label={label} help={help} error={error} htmlFor={id} />
      <select
        id={id}
        className={styles.select}
        value={value ?? ''}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          onChange(opt ? opt.value : e.target.value);
        }}
        disabled={disabled}
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)} disabled={opt.disabled}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

export function TextField({ label, help, value, onChange, error, placeholder, maxLength, type = 'text', mono = false, disabled = false }) {
  const id = useId();
  return (
    <div className={`${styles.row} ${styles.rowStacked} ${error ? styles.rowInvalid : ''}`}>
      <RowText label={label} help={help} error={error} htmlFor={id} />
      <input
        id={id}
        type={type}
        className={`${styles.textInput} ${mono ? styles.mono : ''}`}
        value={value ?? ''}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
        disabled={disabled}
        autoComplete="off"
      />
    </div>
  );
}

// Renderiza un esquema normalizado (ver paramSchema.js).
export function ParamFields({ schema, values, errors = {}, onChange, disabled = false }) {
  if (!schema.length) {
    return <p className={styles.empty}>Esta plantilla no tiene parámetros configurables.</p>;
  }
  return schema.map((spec) => {
    const value = values?.[spec.key];
    const set = (v) => onChange({ ...values, [spec.key]: v });
    if (spec.type === 'boolean') {
      return <SwitchField key={spec.key} label={spec.label} help={spec.help} checked={!!value} onChange={set} disabled={disabled} />;
    }
    if (spec.type === 'select') {
      return (
        <ChoiceField
          key={spec.key}
          label={spec.label}
          help={spec.help}
          options={spec.options}
          value={value}
          onChange={set}
          error={errors[spec.key]}
          disabled={disabled}
        />
      );
    }
    if (spec.type === 'text') {
      return <TextField key={spec.key} label={spec.label} help={spec.help} value={value} onChange={set} error={errors[spec.key]} disabled={disabled} />;
    }
    return (
      <NumberField
        key={spec.key}
        label={spec.label}
        help={spec.help}
        unit={spec.unit}
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        integer={spec.type === 'integer'}
        error={errors[spec.key]}
        onChange={set}
        disabled={disabled}
      />
    );
  });
}
