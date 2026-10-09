import { useId, useState } from 'react';
import { INDICATORS } from '../indicators/catalog';
import { MinusIcon, PlusIcon } from './icons';
import { normalizeNumber, parseNumberInput, stepNumber } from './stepperMath';
import styles from './IndicatorSettingsForm.module.css';

const DEFAULT_COLOR = '#60a5fa';
const LINE_WIDTHS = [1, 2, 3, 4];
const LINE_STYLES = [
  { value: 'solid', label: 'Continua' },
  { value: 'dashed', label: 'Discontinua' },
  { value: 'dotted', label: 'Punteada' },
];

// Los booleanos «Mostrar …» sólo encienden/apagan series: van en su propia
// sección para no mezclarlos con los que cambian el cálculo (p. ej. True Range).
const isVisibilityToggle = (spec) => spec.type === 'boolean' && /^show/.test(spec.key);

function Section({ title, children }) {
  const id = useId();
  return (
    <div className={styles.section} role="group" aria-labelledby={id}>
      <div id={id} className={styles.sectionLabel}>{title}</div>
      <div className={styles.card}>{children}</div>
    </div>
  );
}

// Stepper − [valor] +. El texto se guarda como borrador mientras se escribe
// para permitir valores intermedios ('1' camino de '15', '1,' camino de '1,5');
// sólo se limita y redondea al confirmar (blur o Enter).
function NumberStepper({ spec, value, onCommit }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const { min, max } = spec;
  const current = Number.isFinite(value) ? value : 0;

  const commit = (n) => {
    setDraft(null);
    if (n !== value) onCommit(n);
  };

  const confirmDraft = () => {
    if (draft === null) return;
    const parsed = parseNumberInput(draft);
    if (parsed === null) {
      setDraft(null);
      return;
    }
    commit(normalizeNumber(parsed, spec));
  };

  const step = (direction) => commit(stepNumber(current, direction, spec));

  const handleChange = (e) => {
    const raw = e.target.value;
    setDraft(raw);
    // Si lo tecleado ya es válido se propaga en vivo, como hacía el input
    // nativo; lo que queda fuera de rango espera al blur.
    const parsed = parseNumberInput(raw);
    const inRange = parsed !== null
      && !(Number.isFinite(min) && parsed < min)
      && !(Number.isFinite(max) && parsed > max);
    if (inRange && parsed !== value) onCommit(parsed);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmDraft();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Paridad con el input type=number de escritorio.
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
    }
  };

  const atMin = Number.isFinite(min) && current <= min;
  const atMax = Number.isFinite(max) && current >= max;

  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.rowLabel}>{spec.label}</label>
      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => step(-1)}
          disabled={atMin}
          aria-label={`Disminuir ${spec.label}`}
        >
          <MinusIcon size={18} />
        </button>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={styles.stepInput}
          value={draft ?? String(current)}
          onChange={handleChange}
          onBlur={confirmDraft}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={styles.stepBtn}
          onClick={() => step(1)}
          disabled={atMax}
          aria-label={`Aumentar ${spec.label}`}
        >
          <PlusIcon size={18} />
        </button>
      </div>
    </div>
  );
}

// Fila entera pulsable: el nombre accesible del switch es su propio texto.
function SwitchRow({ label, checked, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`${styles.row} ${styles.switchRow}`}
      onClick={() => onToggle(!checked)}
    >
      <span className={styles.rowLabel}>{label}</span>
      <span className={`${styles.track} ${checked ? styles.trackOn : ''}`} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}

// Acepta #rgb y #rrggbb; el input nativo de color sólo entiende la forma larga.
function normalizeHex(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

function ColorRow({ value, onCommit }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const color = normalizeHex(value) || DEFAULT_COLOR;

  const confirmDraft = () => {
    if (draft === null) return;
    const hex = normalizeHex(draft);
    setDraft(null);
    if (hex && hex !== color) onCommit(hex);
  };

  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.rowLabel}>Color</label>
      <div className={styles.colorControl}>
        <input
          type="text"
          className={styles.hexInput}
          aria-label="Color (hex)"
          autoComplete="off"
          spellCheck={false}
          value={draft ?? color}
          onChange={(e) => {
            setDraft(e.target.value);
            // Seis dígitos ya es un color completo: se aplica sin esperar.
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value.trim())) onCommit(e.target.value.trim().toLowerCase());
          }}
          onBlur={confirmDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirmDraft();
            }
          }}
        />
        {/* El input nativo queda invisible encima de la muestra: así el área
            táctil es de 44px aunque el control del sistema sea más pequeño. */}
        <span className={styles.swatch} style={{ background: color }}>
          <input
            id={id}
            type="color"
            className={styles.colorInput}
            value={color}
            onChange={(e) => {
              setDraft(null);
              onCommit(e.target.value);
            }}
          />
        </span>
      </div>
    </div>
  );
}

function SegmentedRow({ label, options, value, onSelect }) {
  const id = useId();
  return (
    <div className={`${styles.row} ${styles.rowStacked}`}>
      <span id={id} className={styles.rowLabel}>{label}</span>
      <div className={styles.segmented} role="group" aria-labelledby={id}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`${styles.segment} ${opt.value === value ? styles.segmentActive : ''}`}
            aria-pressed={opt.value === value}
            aria-label={opt.ariaLabel}
            onClick={() => onSelect(opt.value)}
          >
            {opt.content}
          </button>
        ))}
      </div>
    </div>
  );
}

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

  const schema = meta.paramSchema || [];
  const paramSpecs = schema.filter((s) => !isVisibilityToggle(s));
  const visibilitySpecs = schema.filter(isVisibilityToggle);
  const hasStyle = meta.pane === 'overlay';
  const valueOf = (spec) => indicator.params?.[spec.key] ?? meta.defaultParams?.[spec.key];

  const renderSpec = (spec) => {
    const value = valueOf(spec);
    if (spec.type === 'number') {
      return (
        <NumberStepper
          key={spec.key}
          spec={spec}
          value={Number(value)}
          onCommit={(n) => updateParam(spec.key, n)}
        />
      );
    }
    if (spec.type === 'boolean') {
      return (
        <SwitchRow
          key={spec.key}
          label={spec.label}
          checked={!!value}
          onToggle={(next) => updateParam(spec.key, next)}
        />
      );
    }
    return null;
  };

  const lineWidth = indicator.style?.lineWidth || meta.defaultStyle?.lineWidth || 2;
  const lineStyle = indicator.style?.lineStyle || 'solid';

  return (
    <div className={styles.form}>
      <div className={styles.header}>
        <div className={styles.title}>{meta.label}</div>
        <div className={styles.subtitle}>{meta.fullName}</div>
      </div>

      {paramSpecs.length > 0 && <Section title="Parámetros">{paramSpecs.map(renderSpec)}</Section>}
      {visibilitySpecs.length > 0 && <Section title="Visibilidad">{visibilitySpecs.map(renderSpec)}</Section>}

      {hasStyle && (
        <Section title="Estilo">
          <ColorRow
            value={indicator.style?.color || meta.defaultStyle?.color || DEFAULT_COLOR}
            onCommit={(hex) => updateStyle('color', hex)}
          />
          <SegmentedRow
            label="Grosor de línea"
            value={lineWidth}
            onSelect={(w) => updateStyle('lineWidth', w)}
            options={LINE_WIDTHS.map((w) => ({
              value: w,
              ariaLabel: `Grosor ${w}px`,
              content: <span className={styles.widthSample} style={{ height: w }} />,
            }))}
          />
          <SegmentedRow
            label="Tipo de línea"
            value={lineStyle}
            onSelect={(s) => updateStyle('lineStyle', s)}
            options={LINE_STYLES.map((s) => ({
              value: s.value,
              content: (
                <>
                  <span className={styles.styleSample} style={{ borderTopStyle: s.value }} aria-hidden="true" />
                  <span className={styles.segmentText}>{s.label}</span>
                </>
              ),
            }))}
          />
        </Section>
      )}

      {paramSpecs.length === 0 && visibilitySpecs.length === 0 && !hasStyle && (
        <p className={styles.empty}>Este indicador no tiene ajustes configurables.</p>
      )}
    </div>
  );
}
