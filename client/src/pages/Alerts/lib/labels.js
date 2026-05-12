/**
 * Etiquetas y helpers para mostrar las reglas en lenguaje humano.
 * El "wire format" (operandSeries='line', operator='<', …) se conserva intacto;
 * estos labels son solo para la UI.
 */

import { INDICATORS } from '../../TradingView/indicators/catalog';

export const ROLE_LABELS = {
  line: 'valor',
  macd: 'MACD',
  signal: 'señal',
  histogram: 'histograma',
  k: '%K',
  d: '%D',
  upper: 'banda superior',
  middle: 'banda media',
  lower: 'banda inferior',
  adx: 'ADX',
  pdi: '+DI',
  mdi: '−DI',
  sqzMomentum: 'momentum',
  normalUpper: 'banda superior normal',
  normalMiddle: 'media normal',
  normalLower: 'banda inferior normal',
  sqzState: 'estado squeeze',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export function indicatorLabel(type) {
  return INDICATORS[type]?.label || type;
}

// Operadores disponibles por indicador. Los específicos (squeeze_*, momentum_*,
// above_upper, etc.) solo aparecen si el indicador los soporta.
const BAND_INDICATORS = new Set(['bollinger', 'keltner']);

const BASE_OPS = [
  { value: '>',  label: '>' },
  { value: '<',  label: '<' },
  { value: '=',  label: '=' },
  { value: '>=', label: '≥' },
  { value: '<=', label: '≤' },
  { value: 'between',    label: 'entre …' },
  { value: 'cross_up',   label: 'cruza ↑' },
  { value: 'cross_down', label: 'cruza ↓' },
];
const BAND_OPS = [
  { value: 'above_upper',  label: '> banda sup' },
  { value: 'below_lower',  label: '< banda inf' },
  { value: 'above_middle', label: '> banda med' },
  { value: 'below_middle', label: '< banda med' },
];
const SQZ_OPS = [
  { value: 'squeeze_on',        label: 'squeeze ON' },
  { value: 'squeeze_off',       label: 'squeeze OFF' },
  { value: 'momentum_positive', label: 'momentum +' },
  { value: 'momentum_negative', label: 'momentum −' },
  { value: 'momentum_redirect_bullish', label: 'redirección alcista' },
  { value: 'momentum_redirect_bearish', label: 'redirección bajista' },
];

export function operatorsFor(indicatorType) {
  const list = [...BASE_OPS];
  if (BAND_INDICATORS.has(indicatorType)) list.push(...BAND_OPS);
  if (indicatorType === 'sqzmom') list.push(...SQZ_OPS);
  return list;
}

export function isOperatorCompatible(indicatorType, op) {
  return operatorsFor(indicatorType).some((o) => o.value === op);
}

// ------------------------------------------------------------------
// Resumen en lenguaje natural
// ------------------------------------------------------------------

function fmtNum(v) {
  if (v == null) return '?';
  if (Number.isInteger(v)) return String(v);
  return Number(v).toFixed(2).replace(/\.?0+$/, '');
}

function paramSummary(type, params) {
  if (!params) return '';
  const meta = INDICATORS[type];
  if (!meta) return '';
  const keys = (meta.paramSchema || []).map((p) => p.key);
  const vals = keys.map((k) => params[k]).filter((v) => v !== undefined && typeof v !== 'boolean');
  return vals.length ? `(${vals.map(fmtNum).join(',')})` : '';
}

function operandSummary(operand, condition) {
  if (!operand) return '';
  switch (operand.kind) {
    case 'constant':    return fmtNum(operand.value);
    case 'between':     return `[${fmtNum(operand.lower)}, ${fmtNum(operand.upper)}]`;
    case 'price':       return 'precio';
    case 'self_offset': return `sí mismo hace ${operand.offset} vela${operand.offset === 1 ? '' : 's'}`;
    case 'series': {
      const tf = operand.timeframe;
      const tfTxt = tf && tf !== condition?.timeframe ? `@${tf}` : '';
      return `${indicatorLabel(operand.indicatorType)}${paramSummary(operand.indicatorType, operand.indicatorParams)}${tfTxt}.${roleLabel(operand.operandSeries)}`;
    }
    case 'none':        return '';
    default:            return '';
  }
}

const OP_SYMBOL = {
  '>': '>', '<': '<', '=': '=', '>=': '≥', '<=': '≤',
  'between': 'entre',
  'cross_up':   'cruza ↑',
  'cross_down': 'cruza ↓',
};
const OP_STATE = {
  above_upper: 'sobre banda sup',
  below_lower: 'bajo banda inf',
  above_middle: 'sobre banda med',
  below_middle: 'bajo banda med',
  squeeze_on:  'squeeze ON',
  squeeze_off: 'squeeze OFF',
  momentum_positive: 'momentum +',
  momentum_negative: 'momentum −',
  momentum_redirect_bullish: 'redirección alcista',
  momentum_redirect_bearish: 'redirección bajista',
};

export function summarizeCondition(c) {
  if (!c) return '';
  const ind = `${indicatorLabel(c.indicatorType)}${paramSummary(c.indicatorType, c.indicatorParams)}@${c.timeframe || '?'}`;
  if (c.operator in OP_STATE) return `${ind}: ${OP_STATE[c.operator]}`;
  const symbol = OP_SYMBOL[c.operator] || c.operator;
  const role = roleLabel(c.operandSeries || 'line');
  const rhs = operandSummary(c.operand, c);
  return `${ind}.${role} ${symbol} ${rhs}`.trim();
}

export function summarizeRule(rule) {
  if (!rule) return '';
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [rule];
  const joiners = Array.isArray(rule.joiners) ? rule.joiners : [];
  const out = [summarizeCondition(conds[0])];
  for (let i = 1; i < conds.length; i += 1) {
    out.push((joiners[i - 1] || 'and') === 'or' ? 'O' : 'Y', summarizeCondition(conds[i]));
  }
  return out.join(' ');
}

// ------------------------------------------------------------------
// Cooldown: presets amigables
// ------------------------------------------------------------------

export const COOLDOWN_PRESETS = [
  { value: 0,    label: 'sin' },
  { value: 60,   label: '1 min' },
  { value: 300,  label: '5 min' },
  { value: 900,  label: '15 min' },
  { value: 3600, label: '1 h' },
  { value: 14400, label: '4 h' },
];

export function cooldownLabel(seconds) {
  const preset = COOLDOWN_PRESETS.find((p) => p.value === Number(seconds));
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
