import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  IndicatorField,
  MobileTextField,
  OperandField,
  OperatorField,
  ParamFields,
  SeriesField,
  TimeframeField,
  mobileLabelClass,
  paramsSummary,
  ruleParts,
  ruleWithCondition,
  ruleWithJoiner,
  ruleWithNewCondition,
  ruleWithoutCondition,
  visibleParamSchema,
} from '../components/ConditionFields';
import styles from './MobileRuleSheet.module.css';

const WEIGHT_STEP = 0.5;
const weightFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
const roundWeight = (v) => Math.max(0, Math.round(v * 100) / 100);

// Clave local y estable de cada condición del borrador (para `key`): así
// quitar una condición no pasa el estado plegado/desplegado a la siguiente.
// Solo vive en el borrador; se quita antes de `onApply`.
const DRAFT_KEY = '__draftKey';
let draftKeySeq = 0;
function withDraftKeys(rule) {
  const { conditions } = ruleParts(rule);
  if (conditions.every((c) => c[DRAFT_KEY])) return rule;
  return {
    ...rule,
    conditions: conditions.map((c) => (c[DRAFT_KEY] ? c : { ...c, [DRAFT_KEY]: `c${++draftKeySeq}` })),
  };
}
function withoutDraftKeys(rule) {
  if (!Array.isArray(rule.conditions)) return rule;
  return {
    ...rule,
    conditions: rule.conditions.map((c) => {
      const { [DRAFT_KEY]: _key, ...rest } = c;
      return rest;
    }),
  };
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

function Chevron({ open }) {
  return (
    <svg className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Una condición en tarjeta, a una columna. Los campos y su lógica son los
// de escritorio (ConditionFields) en presentación móvil.
function ConditionCard({ condition, index, onChange, onRemove }) {
  const id = useId();
  const [paramsOpen, setParamsOpen] = useState(false);
  const hasParams = useMemo(() => visibleParamSchema(condition.indicatorType).length > 0, [condition.indicatorType]);
  const fieldProps = { condition, onChange, layout: 'mobile', id };

  return (
    <fieldset className={styles.cond} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className={styles.condTitle}>Condición {index + 1}</h3>
      <IndicatorField {...fieldProps} />
      <TimeframeField {...fieldProps} />
      <SeriesField {...fieldProps} />
      <OperatorField {...fieldProps} label="Condición" />
      <OperandField {...fieldProps} />
      {hasParams && (
        <>
          <button
            type="button"
            className={styles.paramsToggle}
            aria-expanded={paramsOpen}
            aria-controls={`${id}-params`}
            onClick={() => setParamsOpen((v) => !v)}
          >
            <span className={styles.paramsText}>
              <span className={styles.paramsTitle}>Parámetros del indicador</span>
              <span className={styles.paramsSummary}>{paramsSummary(condition.indicatorType, condition.indicatorParams)}</span>
            </span>
            <Chevron open={paramsOpen} />
          </button>
          {paramsOpen && (
            <div id={`${id}-params`} className={styles.paramsGrid}>
              <ParamFields {...fieldProps} />
            </div>
          )}
        </>
      )}
      {onRemove && (
        <button type="button" className={styles.removeCond} onClick={onRemove} aria-label={`Quitar condición ${index + 1}`}>
          Quitar condición
        </button>
      )}
    </fieldset>
  );
}

function JoinerToggle({ index, value, onChange }) {
  const current = value === 'or' ? 'or' : 'and';
  return (
    <fieldset className={styles.joiner} aria-label={`Unión entre condición ${index + 1} y ${index + 2}`}>
      {[['and', 'Y'], ['or', 'O']].map(([v, text]) => (
        <button
          key={v}
          type="button"
          className={`${styles.joinerBtn} ${current === v ? styles.joinerOn : ''}`}
          aria-pressed={current === v}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
      <span className={styles.joinerHint}>{current === 'or' ? 'basta con una' : 'deben cumplirse ambas'}</span>
    </fieldset>
  );
}

function SheetContent({ index, rule, isNew, canDelete, onApply, onDiscard, onDelete }) {
  const ids = useId();
  const titleRef = useRef(null);
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState(() => withDraftKeys(structuredClone(rule)));
  const edit = (fn) => setDraft((d) => withDraftKeys(fn(d)));
  const { conditions, joiners } = ruleParts(draft);
  const weight = Number.isFinite(Number(draft.weight)) ? Number(draft.weight) : 1;

  // Foco al título al abrir; al cerrar vuelve a donde estaba (la tarjeta).
  useEffect(() => {
    const previous = document.activeElement;
    titleRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus?.(); };
  }, []);

  // Escape = descartar (siempre con el último callback). Tab y Mayús+Tab
  // dan la vuelta dentro de la hoja (aria-modal): el editor de debajo no
  // recibe el foco.
  const discardRef = useRef(onDiscard);
  useEffect(() => { discardRef.current = onDiscard; }, [onDiscard]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { discardRef.current?.(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = dialogRef.current.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const setWeight = (v) => edit((d) => ({ ...d, weight: roundWeight(v) }));

  return (
    <div className={styles.layer}>
      <section ref={dialogRef} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`}>
        <header className={styles.header}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onDiscard}
            aria-label="Descartar cambios"
            title={isNew ? 'Descartar: la regla nueva no se añade' : 'Descartar cambios'}
          >
            <CloseIcon />
          </button>
          <h2 id={`${ids}-title`} ref={titleRef} tabIndex={-1} className={styles.title}>Regla {index + 1}</h2>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.trash}`}
            onClick={onDelete}
            disabled={!canDelete}
            aria-label="Eliminar regla"
            title={canDelete ? undefined : 'La alerta necesita al menos una regla'}
          >
            <TrashIcon />
          </button>
        </header>

        <div className={styles.body}>
          <MobileTextField
            id={`${ids}-label`}
            label="Etiqueta en Telegram"
            maxLength={120}
            value={draft.label || ''}
            onChange={(e) => { const label = e.target.value; edit((d) => ({ ...d, label })); }}
            placeholder="Ej: RSI sobreventa"
          />

          <fieldset className={styles.weightRow}>
            <legend className={mobileLabelClass}>Peso de la regla</legend>
            <div className={styles.stepper}>
              <button
                type="button"
                className={styles.stepBtn}
                aria-label="Bajar peso"
                disabled={weight <= 0}
                onClick={() => setWeight(weight - WEIGHT_STEP)}
              >
                −
              </button>
              <span className={styles.stepValue} aria-live="polite">{weightFmt.format(weight)}</span>
              <button type="button" className={styles.stepBtn} aria-label="Subir peso" onClick={() => setWeight(weight + WEIGHT_STEP)}>
                +
              </button>
            </div>
          </fieldset>

          {conditions.map((cond, i) => (
            <div key={cond[DRAFT_KEY] || i} className={styles.condItem}>
              {i > 0 && (
                <JoinerToggle
                  index={i - 1}
                  value={joiners[i - 1]}
                  onChange={(v) => edit((d) => ruleWithJoiner(d, i - 1, v))}
                />
              )}
              <ConditionCard
                condition={cond}
                index={i}
                onChange={(next) => edit((d) => ruleWithCondition(d, i, next))}
                onRemove={conditions.length > 1 ? () => edit((d) => ruleWithoutCondition(d, i)) : null}
              />
            </div>
          ))}

          <div className={styles.addRow}>
            <button type="button" className={styles.addBtn} onClick={() => edit((d) => ruleWithNewCondition(d, 'and'))}>
              + Condición «Y»
            </button>
            <button type="button" className={styles.addBtn} onClick={() => edit((d) => ruleWithNewCondition(d, 'or'))}>
              + Condición «O»
            </button>
          </div>
        </div>

        <div className={styles.bar}>
          <button type="button" className={styles.applyBtn} onClick={() => onApply(withoutDraftKeys(draft))}>Aplicar regla</button>
        </div>
      </section>
    </div>
  );
}

// Pantalla 3: edición de UNA regla a pantalla completa sobre el editor
// móvil. Trabaja sobre un borrador (copia de la regla): «Aplicar regla» lo
// devuelve, la ✕ o Escape lo descartan. Quitar una regla nueva al
// descartarla (`isNew`) lo hace la página.
export default function MobileRuleSheet({ open, index, rule, isNew = false, canDelete = true, onApply, onDiscard, onDelete }) {
  if (!open || !rule) return null;
  return (
    <SheetContent
      key={index}
      index={index}
      rule={rule}
      isNew={isNew}
      canDelete={canDelete}
      onApply={onApply}
      onDiscard={onDiscard}
      onDelete={onDelete}
    />
  );
}
