import { useMemo, useState } from 'react';
import { INDICATORS } from '../../TradingView/indicators/catalog';
import { roleLabel, operatorsFor, isOperatorCompatible } from '../lib/labels';
import styles from '../AlertsPage.module.css';
import m from './ConditionFields.module.css';

// Edición de condiciones compartida por el editor de escritorio
// (AlertRuleRow) y la hoja de regla móvil (MobileRuleSheet).
// La lógica vive aquí una sola vez; `layout` solo cambia la presentación:
//   'desktop' (por defecto) → el DOM de siempre de AlertRuleRow;
//   'mobile'                → campos a todo el ancho, etiquetas asociadas.

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];

export const SUPPORTED_TYPES = [
  'sma', 'ema', 'wma', 'rsi', 'macd', 'stoch', 'atr', 'adx',
  'bollinger', 'keltner', 'vwap', 'volume', 'sqzmom',
];

export const ROLES_BY_TYPE = {
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

export const NONE_KIND_OPS = new Set([
  'above_upper', 'below_lower', 'above_middle', 'below_middle',
  'squeeze_on', 'squeeze_off', 'momentum_positive', 'momentum_negative',
  'momentum_redirect_bullish', 'momentum_redirect_bearish',
]);
const BETWEEN_OPS = new Set(['between']);

export function defaultParamsFor(type) {
  const meta = INDICATORS[type];
  if (!meta) return {};
  const blacklist = PARAM_BLACKLIST[type] || new Set();
  const out = {};
  for (const [k, v] of Object.entries(meta.defaultParams || {})) {
    if (!blacklist.has(k)) out[k] = v;
  }
  return out;
}

export function defaultRoleFor(type) {
  if (type === 'macd') return 'macd';
  if (type === 'stoch') return 'k';
  if (type === 'adx')   return 'adx';
  if (type === 'sqzmom') return 'sqzMomentum';
  if (type === 'bollinger' || type === 'keltner') return 'middle';
  return 'line';
}

export function visibleParamSchema(type) {
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
// Transformaciones puras de una condición
// ------------------------------------------------------------------

export function withOperator(condition, op) {
  const patch = { operator: op };
  if (NONE_KIND_OPS.has(op)) patch.operand = { kind: 'none' };
  else if (BETWEEN_OPS.has(op)) patch.operand = { kind: 'between', lower: 0, upper: 100 };
  else if (condition.operand?.kind === 'none' || condition.operand?.kind === 'between') {
    patch.operand = { kind: 'constant', value: 0 };
  }
  return { ...condition, ...patch };
}

export function withIndicatorType(condition, type) {
  // Si el operador actual no aplica al nuevo indicador, lo bajamos a '<'.
  const nextOperator = isOperatorCompatible(type, condition.operator) ? condition.operator : '<';
  const opChange = nextOperator !== condition.operator;
  return {
    ...condition,
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
  };
}

export function withParam(condition, key, value) {
  return { ...condition, indicatorParams: { ...condition.indicatorParams, [key]: value } };
}

function operandOfKind(kind, condition) {
  if (kind === 'constant')    return { kind: 'constant', value: 0 };
  if (kind === 'price')       return { kind: 'price' };
  if (kind === 'self_offset') return { kind: 'self_offset', offset: 1 };
  if (kind === 'series')      return { kind: 'series', indicatorType: 'ema', indicatorParams: { length: 50 }, timeframe: condition.timeframe, operandSeries: 'line' };
  return null;
}

// ------------------------------------------------------------------
// Transformaciones puras de una regla (condiciones + joiners)
// ------------------------------------------------------------------

export function ruleParts(rule) {
  return {
    conditions: Array.isArray(rule.conditions) ? rule.conditions : [emptyCondition()],
    joiners: Array.isArray(rule.joiners) ? rule.joiners : [],
  };
}

export function ruleWithCondition(rule, i, next) {
  const list = ruleParts(rule).conditions.slice();
  list[i] = next;
  return { ...rule, conditions: list };
}

export function ruleWithoutCondition(rule, i) {
  const { conditions, joiners } = ruleParts(rule);
  if (conditions.length <= 1) return rule;
  const list = conditions.slice();
  list.splice(i, 1);
  // Quita el joiner adyacente: si quito la cond i, quito el joiner i-1 (o 0 si i==0)
  const js = joiners.slice();
  if (i === 0) js.splice(0, 1);
  else js.splice(i - 1, 1);
  return { ...rule, conditions: list, joiners: js };
}

export function ruleWithNewCondition(rule, joiner = 'and') {
  const { conditions, joiners } = ruleParts(rule);
  return {
    ...rule,
    conditions: [...conditions, emptyCondition()],
    joiners: [...joiners, joiner],
  };
}

export function ruleWithJoiner(rule, i, value) {
  const js = ruleParts(rule).joiners.slice();
  js[i] = value;
  return { ...rule, joiners: js };
}

// ------------------------------------------------------------------
// Resumen compacto de parámetros: «BB 20/2 · KC 20/1,5 · True Range sí …»
// Etiquetas que empiezan por una sigla («BB periodo», «%K periodo») se
// acortan a la sigla y se agrupan los valores seguidos con «/».
// ------------------------------------------------------------------

const numberFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4, useGrouping: false });

function shortParamLabel(p) {
  const words = String(p.label || p.key).split(/\s+/);
  if (words.length > 1 && /^[%A-Z][A-Z+\-%]{0,3}$/.test(words[0])) return { text: words[0], acronym: true };
  if (p.type === 'boolean' && words.length > 1 && /^(usar|mostrar)$/i.test(words[0])) {
    return { text: words.slice(1).join(' '), acronym: false };
  }
  return { text: words.join(' '), acronym: false };
}

function formatParamValue(p, v) {
  if (p.type === 'boolean') return v ? 'sí' : 'no';
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? numberFmt.format(n) : String(v);
}

export function paramsSummary(type, params = {}) {
  const parts = [];
  for (const p of visibleParamSchema(type)) {
    const { text, acronym } = shortParamLabel(p);
    const value = formatParamValue(p, params[p.key]);
    const last = parts[parts.length - 1];
    if (acronym && last?.acronym && last.text === text) last.values.push(value);
    else parts.push({ text, acronym, values: [value] });
  }
  return parts.map((g) => `${g.text} ${g.values.join('/')}`).join(' · ');
}

// ------------------------------------------------------------------
// Campos (cada uno con su lógica una vez, y dos presentaciones)
// ------------------------------------------------------------------

const isMobile = (layout) => layout === 'mobile';
const selectCls = (layout) => (isMobile(layout) ? m.control : styles.select);
const inputCls = (layout) => (isMobile(layout) ? m.control : styles.input);

function Field({ layout, label, htmlFor, children }) {
  if (isMobile(layout)) {
    return (
      <div className={m.field}>
        <label className={m.label} htmlFor={htmlFor}>{label}</label>
        {children}
      </div>
    );
  }
  return (
    <div className={styles.formField}>
      <label>{label}</label>
      {children}
    </div>
  );
}

// Para otras vistas móviles (la hoja de regla) con el mismo aspecto.
export const mobileLabelClass = m.label;

export function MobileTextField({ id, label, ...inputProps }) {
  return (
    <Field layout="mobile" label={label} htmlFor={id}>
      <input id={id} className={m.control} type="text" {...inputProps} />
    </Field>
  );
}

const fid = (id, name) => (id ? `${id}-${name}` : undefined);

function IndicatorOptions() {
  return SUPPORTED_TYPES.map((id) => INDICATORS[id] && (
    <option key={id} value={id}>{INDICATORS[id].label}</option>
  ));
}

export function IndicatorField({ condition, onChange, layout, id }) {
  return (
    <Field layout={layout} label="Indicador" htmlFor={fid(id, 'ind')}>
      <select
        id={fid(id, 'ind')}
        className={selectCls(layout)}
        value={condition.indicatorType}
        onChange={(e) => onChange(withIndicatorType(condition, e.target.value))}
      >
        <IndicatorOptions />
      </select>
    </Field>
  );
}

const MAIN_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const EXTRA_TIMEFRAMES = TIMEFRAMES.filter((tf) => !MAIN_TIMEFRAMES.includes(tf));
const tfLabel = (tf) => (tf === '1d' ? '1D' : tf);

export function TimeframeField({ condition, onChange, layout }) {
  const setTf = (tf) => onChange({ ...condition, timeframe: tf });
  const inExtra = EXTRA_TIMEFRAMES.includes(condition.timeframe);
  const [showExtra, setShowExtra] = useState(inExtra);

  if (!isMobile(layout)) {
    return (
      <Field layout={layout} label="Timeframe">
        <select className={styles.select} value={condition.timeframe} onChange={(e) => setTf(e.target.value)}>
          {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
        </select>
      </Field>
    );
  }

  const tfButton = (tf) => (
    <button
      key={tf}
      type="button"
      className={`${m.chip} ${condition.timeframe === tf ? m.chipOn : ''}`}
      aria-pressed={condition.timeframe === tf}
      onClick={() => setTf(tf)}
    >
      {tfLabel(tf)}
    </button>
  );

  return (
    <fieldset className={m.fieldset}>
      <legend className={m.label}>Temporalidad</legend>
      <div className={m.chips}>
        {MAIN_TIMEFRAMES.map(tfButton)}
        <button
          type="button"
          className={`${m.chip} ${inExtra ? m.chipOn : ''}`}
          aria-label="Más temporalidades"
          aria-expanded={showExtra}
          onClick={() => setShowExtra((v) => !v)}
        >
          …
        </button>
      </div>
      {showExtra && <div className={m.chipsExtra}>{EXTRA_TIMEFRAMES.map(tfButton)}</div>}
    </fieldset>
  );
}

// Campos de parámetros (sin el contenedor: cada vista pone su rejilla).
export function ParamFields({ condition, onChange, layout, id }) {
  const paramSchema = useMemo(() => visibleParamSchema(condition.indicatorType), [condition.indicatorType]);
  const setParam = (key, value) => onChange(withParam(condition, key, value));

  return paramSchema.map((p) => {
    const value = condition.indicatorParams?.[p.key];
    if (isMobile(layout)) {
      if (p.type === 'boolean') {
        return (
          <label key={p.key} className={m.check}>
            <input type="checkbox" checked={!!value} onChange={(e) => setParam(p.key, e.target.checked)} />
            <span>{p.label}</span>
          </label>
        );
      }
      return (
        <Field key={p.key} layout={layout} label={p.label} htmlFor={fid(id, `p-${p.key}`)}>
          <input
            id={fid(id, `p-${p.key}`)}
            className={m.control}
            type="number"
            inputMode="decimal"
            value={value ?? ''}
            min={p.min} max={p.max} step={p.step}
            onChange={(e) => setParam(p.key, Number(e.target.value))}
          />
        </Field>
      );
    }
    return (
      <div key={p.key} className={styles.formField}>
        <label>{p.label}</label>
        {p.type === 'boolean' ? (
          <label className={styles.boolRow}>
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => setParam(p.key, e.target.checked)}
            />
            <span>{value ? 'Sí' : 'No'}</span>
          </label>
        ) : (
          <input
            className={styles.input}
            type="number"
            value={value ?? ''}
            min={p.min} max={p.max} step={p.step}
            onChange={(e) => setParam(p.key, Number(e.target.value))}
          />
        )}
      </div>
    );
  });
}

export function SeriesField({ condition, onChange, layout, id }) {
  const roles = ROLES_BY_TYPE[condition.indicatorType] || ['line'];
  const implicit = NONE_KIND_OPS.has(condition.operator);
  return (
    <Field layout={layout} label="Serie" htmlFor={fid(id, 'serie')}>
      <select
        id={fid(id, 'serie')}
        className={selectCls(layout)}
        value={condition.operandSeries || defaultRoleFor(condition.indicatorType)}
        onChange={(e) => onChange({ ...condition, operandSeries: e.target.value })}
        disabled={implicit || roles.length === 1}
        title={implicit ? 'No aplica para este operador' : ''}
      >
        {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </select>
    </Field>
  );
}

export function OperatorField({ condition, onChange, layout, id, label = 'Operador' }) {
  const availableOps = useMemo(() => operatorsFor(condition.indicatorType), [condition.indicatorType]);
  return (
    <Field layout={layout} label={label} htmlFor={fid(id, 'op')}>
      <select
        id={fid(id, 'op')}
        className={selectCls(layout)}
        value={condition.operator}
        onChange={(e) => onChange(withOperator(condition, e.target.value))}
      >
        {availableOps.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>
    </Field>
  );
}

const OPERAND_KINDS = [
  { value: 'constant', label: 'valor' },
  { value: 'price', label: 'precio' },
  { value: 'self_offset', label: 'consigo mismo' },
  { value: 'series', label: 'otro indicador' },
];

export function OperandField({ condition, onChange, layout, id }) {
  const mobile = isMobile(layout);
  const operandKind = condition.operand?.kind || 'constant';
  const setOperand = (operand) => onChange({ ...condition, operand });
  const setBound = (key, v) => setOperand({ ...condition.operand, kind: 'between', [key]: Number(v) });
  const setKind = (k) => { const next = operandOfKind(k, condition); if (next) setOperand(next); };
  const setConstant = (v) => setOperand({ kind: 'constant', value: Number(v) });
  const setOffset = (v) => setOperand({ kind: 'self_offset', offset: Math.max(1, parseInt(v, 10) || 1) });
  const operandCls = `${styles.formField} ${styles.operandField}`;

  if (NONE_KIND_OPS.has(condition.operator)) {
    if (mobile) return null;
    return (
      <div className={operandCls}>
        <label>Operando</label>
        <span className={styles.operandStatic}>(implícito en el operador)</span>
      </div>
    );
  }

  if (operandKind === 'between') {
    const lower = (
      <input
        id={fid(id, 'lo')}
        className={inputCls(layout)} type="number" step="any"
        inputMode={mobile ? 'decimal' : undefined}
        value={condition.operand?.lower ?? 0}
        onChange={(e) => setBound('lower', e.target.value)}
        placeholder="min"
      />
    );
    const upper = (
      <input
        id={fid(id, 'hi')}
        className={inputCls(layout)} type="number" step="any"
        inputMode={mobile ? 'decimal' : undefined}
        value={condition.operand?.upper ?? 0}
        onChange={(e) => setBound('upper', e.target.value)}
        placeholder="max"
      />
    );
    if (mobile) {
      return (
        <div className={m.pair}>
          <Field layout={layout} label="Desde" htmlFor={fid(id, 'lo')}>{lower}</Field>
          <Field layout={layout} label="Hasta" htmlFor={fid(id, 'hi')}>{upper}</Field>
        </div>
      );
    }
    return (
      <div className={operandCls}>
        <label>Operando</label>
        <div className={styles.inlineInputs}>
          {lower}
          <span className={styles.inlineSep}>…</span>
          {upper}
        </div>
      </div>
    );
  }

  const kindSelect = (
    <select
      id={fid(id, 'kind')}
      className={selectCls(layout)}
      style={mobile ? undefined : { width: 120 }}
      value={operandKind}
      onChange={(e) => setKind(e.target.value)}
    >
      {OPERAND_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
    </select>
  );
  const constantInput = (
    <input
      id={fid(id, 'val')}
      className={inputCls(layout)}
      type="number" step="any"
      inputMode={mobile ? 'decimal' : undefined}
      value={condition.operand?.value ?? 0}
      onChange={(e) => setConstant(e.target.value)}
    />
  );
  const offsetInput = (
    <input
      id={fid(id, 'off')}
      className={inputCls(layout)}
      style={mobile ? undefined : { width: 70 }}
      type="number" min="1" step="1"
      inputMode={mobile ? 'numeric' : undefined}
      value={condition.operand?.offset ?? 1}
      onChange={(e) => setOffset(e.target.value)}
    />
  );
  const seriesOperand = operandKind === 'series' && (
    <SeriesOperand operand={condition.operand} onChange={setOperand} layout={layout} id={fid(id, 'rhs')} />
  );

  if (mobile) {
    return (
      <>
        <Field layout={layout} label="Comparar con" htmlFor={fid(id, 'kind')}>{kindSelect}</Field>
        {operandKind === 'constant' && <Field layout={layout} label="Valor" htmlFor={fid(id, 'val')}>{constantInput}</Field>}
        {operandKind === 'price' && <p className={m.static}>Último cierre del activo.</p>}
        {operandKind === 'self_offset' && (
          <Field layout={layout} label="Velas atrás (mismo indicador)" htmlFor={fid(id, 'off')}>{offsetInput}</Field>
        )}
        {seriesOperand}
      </>
    );
  }

  return (
    <div className={operandCls}>
      <label>Operando</label>
      <div className={styles.inlineInputs}>
        {kindSelect}
        {operandKind === 'constant' && constantInput}
        {operandKind === 'price' && (
          <span className={styles.operandStatic}>último cierre del activo</span>
        )}
        {operandKind === 'self_offset' && (
          <>
            {offsetInput}
            <span className={styles.operandStatic}>velas atrás (mismo indicador)</span>
          </>
        )}
        {seriesOperand}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Operando "series" (otro indicador como RHS)
// ------------------------------------------------------------------

function SeriesOperand({ operand, onChange, layout, id }) {
  const mobile = isMobile(layout);
  const type = operand.indicatorType || 'ema';
  const params = operand.indicatorParams || {};
  const tf = operand.timeframe || '15m';
  const role = operand.operandSeries || defaultRoleFor(type);
  const roles = ROLES_BY_TYPE[type] || ['line'];
  const schema = visibleParamSchema(type);

  const update = (patch) => onChange({ ...operand, ...patch });
  const setType = (t) => onChange({
    kind: 'series',
    indicatorType: t,
    indicatorParams: defaultParamsFor(t),
    timeframe: tf,
    operandSeries: defaultRoleFor(t),
  });
  const numericParams = schema.slice(0, 3).filter((p) => p.type !== 'boolean');

  if (mobile) {
    return (
      <div className={m.rhs}>
        <Field layout={layout} label="Otro indicador" htmlFor={fid(id, 'ind')}>
          <select id={fid(id, 'ind')} className={m.control} value={type} onChange={(e) => setType(e.target.value)}>
            <IndicatorOptions />
          </select>
        </Field>
        <div className={m.pair}>
          {numericParams.map((p) => (
            <Field key={p.key} layout={layout} label={p.label} htmlFor={fid(id, `p-${p.key}`)}>
              <input
                id={fid(id, `p-${p.key}`)}
                className={m.control}
                type="number"
                inputMode="decimal"
                value={params[p.key] ?? ''}
                min={p.min} max={p.max} step={p.step}
                onChange={(e) => update({ indicatorParams: { ...params, [p.key]: Number(e.target.value) } })}
              />
            </Field>
          ))}
          <Field layout={layout} label="Su temporalidad" htmlFor={fid(id, 'tf')}>
            <select id={fid(id, 'tf')} className={m.control} value={tf} onChange={(e) => update({ timeframe: e.target.value })}>
              {TIMEFRAMES.map((t) => <option key={t} value={t}>{tfLabel(t)}</option>)}
            </select>
          </Field>
          <Field layout={layout} label="Su serie" htmlFor={fid(id, 'role')}>
            <select id={fid(id, 'role')} className={m.control} value={role} onChange={(e) => update({ operandSeries: e.target.value })}>
              {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </Field>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.seriesOperand}>
      <select
        className={styles.select}
        style={{ minWidth: 110 }}
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <IndicatorOptions />
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
