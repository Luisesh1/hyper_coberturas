import { useMemo } from 'react';
import { INDICATORS } from '../../TradingView/indicators/catalog';
import { roleLabel, operatorsFor, isOperatorCompatible, summarizeRule } from '../lib/labels';
import styles from '../AlertsPage.module.css';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];

const SUPPORTED_TYPES = [
  'sma', 'ema', 'wma', 'rsi', 'macd', 'stoch', 'atr', 'adx',
  'bollinger', 'keltner', 'vwap', 'volume', 'sqzmom',
];

const ROLES_BY_TYPE = {
  sma: ['line'], ema: ['line'], wma: ['line'], rsi: ['line'], atr: ['line'],
  vwap: ['line'], volume: ['line'],
  macd: ['macd', 'signal', 'histogram'],
  stoch: ['k', 'd'],
  adx: ['adx', 'pdi', 'mdi'],
  bollinger: ['upper', 'middle', 'lower'],
  keltner: ['upper', 'middle', 'lower'],
  sqzmom: ['sqzMomentum', 'normalUpper', 'normalMiddle', 'normalLower', 'sqzState'],
};

// Parámetros del catálogo del chart que SOLO afectan visualización y deben
// ocultarse del editor de alertas (no influyen en la evaluación).
const PARAM_BLACKLIST = {
  sqzmom: new Set([
    'showNormalUpper', 'showNormalMiddle', 'showNormalLower',
  ]),
  adx: new Set(['showADX', 'showDIPlus', 'showDIMinus']),
};

const NONE_KIND_OPS = new Set([
  'above_upper', 'below_lower', 'above_middle', 'below_middle',
  'squeeze_on', 'squeeze_off', 'momentum_positive', 'momentum_negative',
  'momentum_redirect_bullish', 'momentum_redirect_bearish',
]);
const BETWEEN_OPS = new Set(['between']);

function defaultParamsFor(type) {
  const meta = INDICATORS[type];
  if (!meta) return {};
  const blacklist = PARAM_BLACKLIST[type] || new Set();
  const out = {};
  for (const [k, v] of Object.entries(meta.defaultParams || {})) {
    if (!blacklist.has(k)) out[k] = v;
  }
  return out;
}

function defaultRoleFor(type) {
  if (type === 'macd') return 'macd';
  if (type === 'stoch') return 'k';
  if (type === 'adx')   return 'adx';
  if (type === 'sqzmom') return 'sqzMomentum';
  if (type === 'bollinger' || type === 'keltner') return 'middle';
  return 'line';
}

function visibleParamSchema(type) {
  const meta = INDICATORS[type];
  if (!meta) return [];
  const blacklist = PARAM_BLACKLIST[type] || new Set();
  return (meta.paramSchema || []).filter((p) => !blacklist.has(p.key));
}

export function emptyCondition() {
  return {
    indicatorType: 'rsi',
    indicatorParams: { length: 14 },
    timeframe: '15m',
    operandSeries: 'line',
    operator: '<',
    operand: { kind: 'constant', value: 30 },
  };
}

// ------------------------------------------------------------------
// Editor de UNA condición (sin peso, sin remover-regla)
// ------------------------------------------------------------------

function ConditionEditor({ condition, onChange, onRemove, label }) {
  const roles = ROLES_BY_TYPE[condition.indicatorType] || ['line'];
  const paramSchema = useMemo(() => visibleParamSchema(condition.indicatorType), [condition.indicatorType]);

  const update = (patch) => onChange({ ...condition, ...patch });

  const updateOperator = (op) => {
    const patch = { operator: op };
    if (NONE_KIND_OPS.has(op)) patch.operand = { kind: 'none' };
    else if (BETWEEN_OPS.has(op)) patch.operand = { kind: 'between', lower: 0, upper: 100 };
    else if (condition.operand?.kind === 'none' || condition.operand?.kind === 'between') {
      patch.operand = { kind: 'constant', value: 0 };
    }
    onChange({ ...condition, ...patch });
  };

  const updateIndicatorType = (type) => {
    // Si el operador actual no aplica al nuevo indicador, lo bajamos a '<'.
    const nextOperator = isOperatorCompatible(type, condition.operator) ? condition.operator : '<';
    const opChange = nextOperator !== condition.operator;
    update({
      indicatorType: type,
      indicatorParams: defaultParamsFor(type),
      operandSeries: defaultRoleFor(type),
      ...(opChange ? {
        operator: nextOperator,
        operand: NONE_KIND_OPS.has(nextOperator)
          ? { kind: 'none' }
          : BETWEEN_OPS.has(nextOperator)
            ? { kind: 'between', lower: 0, upper: 100 }
            : { kind: 'constant', value: 0 },
      } : {}),
    });
  };

  const updateParam = (key, value) => {
    update({ indicatorParams: { ...condition.indicatorParams, [key]: value } });
  };

  const operandKind = condition.operand?.kind || 'constant';
  const showOperand = !NONE_KIND_OPS.has(condition.operator);
  const availableOps = useMemo(() => operatorsFor(condition.indicatorType), [condition.indicatorType]);

  return (
    <div className={styles.conditionCard}>
      <div className={styles.conditionHead}>
        <span className={styles.conditionLabel}>{label}</span>
        {onRemove && (
          <button type="button" className={styles.removeCondBtn} onClick={onRemove} title="Eliminar condición">×</button>
        )}
      </div>

      <div className={styles.conditionFields}>
        <div className={styles.formField}>
          <label>Indicador</label>
          <select
            className={styles.select}
            value={condition.indicatorType}
            onChange={(e) => updateIndicatorType(e.target.value)}
          >
            {SUPPORTED_TYPES.map((id) => INDICATORS[id] && (
              <option key={id} value={id}>{INDICATORS[id].label}</option>
            ))}
          </select>
        </div>
        <div className={styles.formField}>
          <label>Timeframe</label>
          <select className={styles.select} value={condition.timeframe} onChange={(e) => update({ timeframe: e.target.value })}>
            {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
      </div>

      {paramSchema.length > 0 && (
        <div className={styles.ruleSection}>
          <span className={styles.ruleSectionTitle}>Parámetros del indicador</span>
          <div className={styles.paramGrid}>
            {paramSchema.map((p) => (
              <div key={p.key} className={styles.formField}>
                <label>{p.label}</label>
                {p.type === 'boolean' ? (
                  <label className={styles.boolRow}>
                    <input
                      type="checkbox"
                      checked={!!condition.indicatorParams[p.key]}
                      onChange={(e) => updateParam(p.key, e.target.checked)}
                    />
                    <span>{condition.indicatorParams[p.key] ? 'Sí' : 'No'}</span>
                  </label>
                ) : (
                  <input
                    className={styles.input}
                    type="number"
                    value={condition.indicatorParams[p.key] ?? ''}
                    min={p.min} max={p.max} step={p.step}
                    onChange={(e) => updateParam(p.key, Number(e.target.value))}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.ruleSection}>
        <span className={styles.ruleSectionTitle}>Condición</span>
        <div className={styles.conditionGrid}>
          <div className={styles.formField}>
            <label>Serie</label>
            <select
              className={styles.select}
              value={condition.operandSeries || defaultRoleFor(condition.indicatorType)}
              onChange={(e) => update({ operandSeries: e.target.value })}
              disabled={NONE_KIND_OPS.has(condition.operator) || roles.length === 1}
              title={NONE_KIND_OPS.has(condition.operator) ? 'No aplica para este operador' : ''}
            >
              {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>

          <div className={styles.formField}>
            <label>Operador</label>
            <select className={styles.select} value={condition.operator} onChange={(e) => updateOperator(e.target.value)}>
              {availableOps.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
            </select>
          </div>

          {showOperand && (
            <div className={`${styles.formField} ${styles.operandField}`}>
              <label>Operando</label>
              {operandKind === 'between' ? (
                <div className={styles.inlineInputs}>
                  <input
                    className={styles.input} type="number" step="any"
                    value={condition.operand?.lower ?? 0}
                    onChange={(e) => update({ operand: { ...condition.operand, kind: 'between', lower: Number(e.target.value) } })}
                    placeholder="min"
                  />
                  <span className={styles.inlineSep}>…</span>
                  <input
                    className={styles.input} type="number" step="any"
                    value={condition.operand?.upper ?? 0}
                    onChange={(e) => update({ operand: { ...condition.operand, kind: 'between', upper: Number(e.target.value) } })}
                    placeholder="max"
                  />
                </div>
              ) : (
                <div className={styles.inlineInputs}>
                  <select
                    className={styles.select}
                    style={{ width: 120 }}
                    value={operandKind}
                    onChange={(e) => {
                      const k = e.target.value;
                      if (k === 'constant')         update({ operand: { kind: 'constant', value: 0 } });
                      else if (k === 'price')       update({ operand: { kind: 'price' } });
                      else if (k === 'self_offset') update({ operand: { kind: 'self_offset', offset: 1 } });
                      else if (k === 'series')      update({ operand: { kind: 'series', indicatorType: 'ema', indicatorParams: { length: 50 }, timeframe: condition.timeframe, operandSeries: 'line' } });
                    }}
                  >
                    <option value="constant">valor</option>
                    <option value="price">precio</option>
                    <option value="self_offset">consigo mismo</option>
                    <option value="series">otro indicador</option>
                  </select>
                  {operandKind === 'constant' && (
                    <input
                      className={styles.input}
                      type="number" step="any"
                      value={condition.operand?.value ?? 0}
                      onChange={(e) => update({ operand: { kind: 'constant', value: Number(e.target.value) } })}
                    />
                  )}
                  {operandKind === 'price' && (
                    <span className={styles.operandStatic}>último cierre del activo</span>
                  )}
                  {operandKind === 'self_offset' && (
                    <>
                      <input
                        className={styles.input}
                        style={{ width: 70 }}
                        type="number" min="1" step="1"
                        value={condition.operand?.offset ?? 1}
                        onChange={(e) => update({ operand: { kind: 'self_offset', offset: Math.max(1, parseInt(e.target.value, 10) || 1) } })}
                      />
                      <span className={styles.operandStatic}>velas atrás (mismo indicador)</span>
                    </>
                  )}
                  {operandKind === 'series' && (
                    <SeriesOperandCompact
                      operand={condition.operand}
                      onChange={(next) => update({ operand: next })}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {!showOperand && (
            <div className={`${styles.formField} ${styles.operandField}`}>
              <label>Operando</label>
              <span className={styles.operandStatic}>(implícito en el operador)</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Card de regla: peso + N condiciones encadenadas con AND/OR
// ------------------------------------------------------------------

export function AlertRuleRow({ rule, onChange, onRemove, index }) {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [emptyCondition()];
  const joiners = Array.isArray(rule.joiners) ? rule.joiners : [];

  const update = (patch) => onChange({ ...rule, ...patch });

  const updateCondition = (i, next) => {
    const list = conditions.slice();
    list[i] = next;
    update({ conditions: list });
  };

  const removeCondition = (i) => {
    if (conditions.length <= 1) return;
    const list = conditions.slice();
    list.splice(i, 1);
    // Quita el joiner adyacente: si quito la cond i, quito el joiner i-1 (o 0 si i==0)
    const js = joiners.slice();
    if (i === 0) js.splice(0, 1);
    else js.splice(i - 1, 1);
    update({ conditions: list, joiners: js });
  };

  const addCondition = () => {
    update({
      conditions: [...conditions, emptyCondition()],
      joiners: [...joiners, 'and'],
    });
  };

  const setJoiner = (i, value) => {
    const js = joiners.slice();
    js[i] = value;
    update({ joiners: js });
  };

  return (
    <div className={styles.ruleCard}>
      <div className={styles.ruleHead}>
        <span className={styles.ruleNum}>Regla #{index + 1}</span>
        <div className={styles.ruleHeadFields}>
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

// ------------------------------------------------------------------
// Operando "series" (otro indicador como RHS) — compacto inline
// ------------------------------------------------------------------

function SeriesOperandCompact({ operand, onChange }) {
  const type = operand.indicatorType || 'ema';
  const params = operand.indicatorParams || {};
  const tf = operand.timeframe || '15m';
  const role = operand.operandSeries || defaultRoleFor(type);
  const roles = ROLES_BY_TYPE[type] || ['line'];
  const schema = visibleParamSchema(type);

  const update = (patch) => onChange({ ...operand, ...patch });

  return (
    <div className={styles.seriesOperand}>
      <select
        className={styles.select}
        style={{ minWidth: 110 }}
        value={type}
        onChange={(e) => {
          const t = e.target.value;
          onChange({
            kind: 'series',
            indicatorType: t,
            indicatorParams: defaultParamsFor(t),
            timeframe: tf,
            operandSeries: defaultRoleFor(t),
          });
        }}
      >
        {SUPPORTED_TYPES.map((id) => INDICATORS[id] && (
          <option key={id} value={id}>{INDICATORS[id].label}</option>
        ))}
      </select>
      {schema.slice(0, 3).map((p) => (
        p.type === 'boolean' ? null : (
          <input
            key={p.key}
            className={styles.input}
            style={{ width: 60 }}
            type="number"
            title={p.label}
            value={params[p.key] ?? ''}
            min={p.min} max={p.max} step={p.step}
            onChange={(e) => update({ indicatorParams: { ...params, [p.key]: Number(e.target.value) } })}
          />
        )
      ))}
      <select
        className={styles.select}
        style={{ width: 78 }}
        value={tf}
        onChange={(e) => update({ timeframe: e.target.value })}
      >
        {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select
        className={styles.select}
        style={{ width: 100 }}
        value={role}
        onChange={(e) => update({ operandSeries: e.target.value })}
      >
        {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </select>
    </div>
  );
}
