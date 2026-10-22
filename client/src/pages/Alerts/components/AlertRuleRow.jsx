import { useMemo } from 'react';
import { summarizeRule } from '../lib/labels';
import {
  IndicatorField,
  OperandField,
  OperatorField,
  ParamFields,
  SeriesField,
  TimeframeField,
  emptyCondition,
  ruleParts,
  ruleWithCondition,
  ruleWithJoiner,
  ruleWithNewCondition,
  ruleWithoutCondition,
  visibleParamSchema,
} from './ConditionFields';
import styles from '../AlertsPage.module.css';

export { emptyCondition };

// ------------------------------------------------------------------
// Editor de UNA condición (sin peso, sin remover-regla)
// ------------------------------------------------------------------

function ConditionEditor({ condition, onChange, onRemove, label }) {
  const paramSchema = useMemo(() => visibleParamSchema(condition.indicatorType), [condition.indicatorType]);
  const fieldProps = { condition, onChange };

  return (
    <div className={styles.conditionCard}>
      <div className={styles.conditionHead}>
        <span className={styles.conditionLabel}>{label}</span>
        {onRemove && (
          <button type="button" className={styles.removeCondBtn} onClick={onRemove} title="Eliminar condición">×</button>
        )}
      </div>

      <div className={styles.conditionFields}>
        <IndicatorField {...fieldProps} />
        <TimeframeField {...fieldProps} />
      </div>

      {paramSchema.length > 0 && (
        <div className={styles.ruleSection}>
          <span className={styles.ruleSectionTitle}>Parámetros del indicador</span>
          <div className={styles.paramGrid}>
            <ParamFields {...fieldProps} />
          </div>
        </div>
      )}

      <div className={styles.ruleSection}>
        <span className={styles.ruleSectionTitle}>Condición</span>
        <div className={styles.conditionGrid}>
          <SeriesField {...fieldProps} />
          <OperatorField {...fieldProps} />
          <OperandField {...fieldProps} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Card de regla: peso + N condiciones encadenadas con AND/OR
// ------------------------------------------------------------------

export function AlertRuleRow({ rule, onChange, onRemove, index }) {
  const { conditions, joiners } = ruleParts(rule);

  const update = (patch) => onChange({ ...rule, ...patch });
  const updateCondition = (i, next) => onChange(ruleWithCondition(rule, i, next));
  const removeCondition = (i) => { if (conditions.length > 1) onChange(ruleWithoutCondition(rule, i)); };
  const addCondition = () => onChange(ruleWithNewCondition(rule, 'and'));
  const setJoiner = (i, value) => onChange(ruleWithJoiner(rule, i, value));

  return (
    <div className={styles.ruleCard}>
      <div className={styles.ruleHead}>
        <span className={styles.ruleNum}>Regla #{index + 1}</span>
        <div className={styles.ruleHeadFields}>
          <div className={styles.formField}>
            <label>Label Telegram</label>
            <input
              className={styles.input}
              type="text"
              maxLength={120}
              value={rule.label || ''}
              onChange={(e) => update({ label: e.target.value })}
              placeholder="Ej: RSI sobreventa"
            />
          </div>
          <div className={styles.formField}>
            <label>Peso</label>
            <input
              className={styles.input}
              type="number" min="0" step="0.1"
              value={rule.weight ?? 1}
              onChange={(e) => update({ weight: Number(e.target.value) })}
            />
          </div>
        </div>
        <button type="button" className={styles.removeRuleBtn} onClick={onRemove} title="Eliminar regla">×</button>
      </div>

      {conditions.map((cond, i) => (
        <div key={i}>
          <ConditionEditor
            condition={cond}
            onChange={(next) => updateCondition(i, next)}
            onRemove={conditions.length > 1 ? () => removeCondition(i) : null}
            label={`Condición ${i + 1}`}
          />
          {i < conditions.length - 1 && (
            <div className={styles.joinerRow}>
              <button
                type="button"
                className={`${styles.joinerBtn} ${joiners[i] === 'and' ? styles.joinerActive : ''}`}
                onClick={() => setJoiner(i, 'and')}
              >
                AND
              </button>
              <button
                type="button"
                className={`${styles.joinerBtn} ${joiners[i] === 'or' ? styles.joinerActive : ''}`}
                onClick={() => setJoiner(i, 'or')}
              >
                OR
              </button>
              <span className={styles.joinerHint}>
                {joiners[i] === 'or' ? 'al menos una se cumple' : 'ambas se cumplen'}
              </span>
            </div>
          )}
        </div>
      ))}

      <button type="button" className={styles.addCondBtn} onClick={addCondition}>
        + Agregar condición
      </button>

      <div className={styles.ruleSummary} title="Versión legible de esta regla">
        <span className={styles.ruleSummaryLabel}>📝 Resumen</span>
        <span className={styles.ruleSummaryText}>{summarizeRule(rule) || '—'}</span>
      </div>
    </div>
  );
}
