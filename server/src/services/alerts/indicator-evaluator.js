/**
 * indicator-evaluator.js
 *
 * Calcula indicadores y evalúa reglas individuales de una alerta.
 *
 * Para cada tipo de indicador devuelve un mapa de "roles" (líneas) ya alineado
 * al array de candles. La regla apunta a un role específico (`operandSeries`)
 * y a un operador. El RHS puede ser una constante, otra serie (otro indicador)
 * o el último precio.
 */

const lib = require('../indicator-library');

const SUPPORTED_INDICATORS = new Set([
  'sma', 'ema', 'wma', 'rsi', 'macd', 'stoch', 'atr', 'adx',
  'bollinger', 'keltner', 'vwap', 'volume', 'sqzmom',
]);

const ROLES_BY_INDICATOR = {
  sma:       ['line'],
  ema:       ['line'],
  wma:       ['line'],
  rsi:       ['line'],
  atr:       ['line'],
  vwap:      ['line'],
  volume:    ['line'],
  macd:      ['macd', 'signal', 'histogram'],
  stoch:     ['k', 'd'],
  adx:       ['adx', 'pdi', 'mdi'],
  bollinger: ['upper', 'middle', 'lower'],
  keltner:   ['upper', 'middle', 'lower'],
  sqzmom:    ['sqzMomentum', 'normalUpper', 'normalMiddle', 'normalLower', 'sqzState'],
};

const DEFAULT_ROLE = {
  sma: 'line', ema: 'line', wma: 'line', rsi: 'line', atr: 'line',
  vwap: 'line', volume: 'line',
  macd: 'macd', stoch: 'k', adx: 'adx', sqzmom: 'sqzMomentum',
  // bollinger / keltner: no default (operadores de banda lo resuelven)
};

function computeRoles(type, candles, params = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  switch (type) {
    case 'sma': return { line: lib.sma(candles, mapPeriod(params, 'length')) };
    case 'ema': return { line: lib.ema(candles, mapPeriod(params, 'length')) };
    case 'wma': return { line: lib.wma(candles, mapPeriod(params, 'length')) };
    case 'rsi': return { line: lib.rsi(candles, mapPeriod(params, 'length')) };
    case 'atr': return { line: lib.atr(candles, mapPeriod(params, 'length')) };
    case 'vwap': return { line: lib.vwap(candles) };
    case 'volume': return { line: candles.map((c) => Number(c?.volume ?? c?.v ?? 0)) };
    case 'macd': {
      const series = lib.macd(candles, {
        fastPeriod:   Number(params.fast)   || 12,
        slowPeriod:   Number(params.slow)   || 26,
        signalPeriod: Number(params.signal) || 9,
      });
      return {
        macd:      series.map((s) => s.macd),
        signal:    series.map((s) => s.signal),
        histogram: series.map((s) => s.histogram),
      };
    }
    case 'stoch':
      return lib.stoch(candles, {
        kLength: Number(params.kLength) || 14,
        dLength: Number(params.dLength) || 3,
        smooth:  Number(params.smooth)  || 3,
      });
    case 'adx':
      return lib.adx(candles, { period: Number(params.length) || 14 });
    case 'bollinger': {
      const series = lib.bollinger(candles, {
        period:     Number(params.length) || 20,
        multiplier: Number(params.stdDev) || 2,
      });
      return {
        upper:  series.map((s) => s.upper),
        middle: series.map((s) => s.middle),
        lower:  series.map((s) => s.lower),
      };
    }
    case 'keltner': {
      const series = lib.keltner(candles, {
        length:     Number(params.length)    || 20,
        atrLength:  Number(params.atrLength) || 10,
        multiplier: Number(params.multiplier) || 1.5,
      });
      return {
        upper:  series.map((s) => s.upper),
        middle: series.map((s) => s.middle),
        lower:  series.map((s) => s.lower),
      };
    }
    case 'sqzmom': {
      const out = lib.sqzmom(candles, {
        length:       Number(params.length)   || 20,
        lengthKC:     Number(params.lengthKC) || 20,
        multKC:       Number(params.multKC)   || 1.5,
        useTrueRange: params.useTrueRange !== false,
        normalBandLength: Number(params.normalBandLength) || 100,
        normalBandSigma:  Number(params.normalBandSigma)  || 2,
      });
      return {
        sqzMomentum: out.momentum,
        normalUpper: out.normalUpper,
        normalMiddle: out.normalMiddle,
        normalLower: out.normalLower,
        sqzState: out.sqzState,
      };
    }
    default:
      return null;
  }
}

function mapPeriod(params, key) {
  return { period: Number(params?.[key]) || Number(params?.period) || 14 };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function lastFiniteIndex(roles, candles) {
  // Última posición donde el role principal y el cierre estén definidos.
  return candles.length - 1;
}

function getRoleSeries(rolesMap, role, candles) {
  if (role === 'price') return candles.map((c) => Number(c.close));
  if (!rolesMap || !(role in rolesMap)) return null;
  return rolesMap[role];
}

function defaultRoleFor(type) {
  return DEFAULT_ROLE[type] || null;
}

function fmt(value, digits = 4) {
  if (value == null || !Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1)    return value.toFixed(digits);
  return value.toFixed(Math.min(8, digits + 2));
}

// ------------------------------------------------------------------
// Operadores
// ------------------------------------------------------------------

function numericCompare(left, right, op) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  switch (op) {
    case '>':  return left >  right;
    case '<':  return left <  right;
    case '=':  return Math.abs(left - right) < 1e-9;
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: return false;
  }
}

function crossUp(leftSeries, rightSeries, idx) {
  if (idx < 1) return false;
  const l1 = leftSeries[idx];
  const l0 = leftSeries[idx - 1];
  const r1 = rightSeries[idx];
  const r0 = rightSeries[idx - 1];
  if (![l1, l0, r1, r0].every(Number.isFinite)) return false;
  return l0 <= r0 && l1 > r1;
}

function crossDown(leftSeries, rightSeries, idx) {
  if (idx < 1) return false;
  const l1 = leftSeries[idx];
  const l0 = leftSeries[idx - 1];
  const r1 = rightSeries[idx];
  const r0 = rightSeries[idx - 1];
  if (![l1, l0, r1, r0].every(Number.isFinite)) return false;
  return l0 >= r0 && l1 < r1;
}

function momentumRedirect(momentum, idx, direction) {
  if (!Array.isArray(momentum) || idx < 2) return { available: false };
  const current = momentum[idx];
  const previous = momentum[idx - 1];
  const beforePrevious = momentum[idx - 2];
  if (![current, previous, beforePrevious].every(Number.isFinite)) {
    return { available: false, current, previous, beforePrevious };
  }
  const matched = direction === 'bullish'
    ? current > previous && previous < beforePrevious
    : current < previous && previous > beforePrevious;
  return { available: true, matched, current, previous, beforePrevious };
}

// ------------------------------------------------------------------
// Normalización legacy → nuevo: una regla puede venir como condición
// plana ({ indicatorType, operator, operand, ... }) o como nueva forma
// con varias condiciones encadenadas ({ conditions: [...], joiners: [...] }).
// ------------------------------------------------------------------

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return { conditions: [], joiners: [], weight: 0 };
  }
  if (Array.isArray(rule.conditions)) {
    return {
      conditions: rule.conditions,
      joiners: Array.isArray(rule.joiners) ? rule.joiners : [],
      weight: Number(rule.weight) || 1,
    };
  }
  // Forma plana (legacy o regla simple)
  return {
    conditions: [{
      indicatorType: rule.indicatorType,
      indicatorParams: rule.indicatorParams,
      timeframe: rule.timeframe,
      operandSeries: rule.operandSeries,
      operator: rule.operator,
      operand: rule.operand,
    }],
    joiners: [],
    weight: Number(rule.weight) || 1,
  };
}

// ------------------------------------------------------------------
// Evaluación de una regla (1 o N condiciones + joiners and/or)
// ------------------------------------------------------------------

function evaluateRule(rule, candlesByTf) {
  const { conditions, joiners } = normalizeRule(rule);
  if (conditions.length === 0) {
    return { matched: false, value: null, threshold: null, reason: 'sin condiciones', conditions: [] };
  }
  const evals = conditions.map((c) => evaluateCondition(c, candlesByTf));

  // Combinación izquierda-a-derecha. Para soportar combinaciones mixtas
  // AND/OR sin construir un AST, asumimos asociación lineal en orden:
  //   c1 op1 c2 op2 c3  →  ((c1 op1 c2) op2 c3)
  let matched = evals[0].matched;
  const parts = [evals[0].reason];
  for (let i = 1; i < evals.length; i += 1) {
    const j = (joiners[i - 1] || 'and').toString().toLowerCase();
    parts.push(j === 'or' ? 'OR' : 'AND', evals[i].reason);
    matched = j === 'or' ? (matched || evals[i].matched) : (matched && evals[i].matched);
  }
  return {
    matched,
    value: evals[0].value,
    threshold: evals[0].threshold,
    reason: parts.join(' '),
    conditions: evals,
  };
}

// Evalúa una sola condición (sin joiners).
function evaluateCondition(rule, candlesByTf) {
  const baseTf = rule.timeframe;
  const baseCandles = candlesByTf[baseTf];
  if (!Array.isArray(baseCandles) || baseCandles.length === 0) {
    return { matched: false, value: null, threshold: null, reason: `sin velas para ${baseTf}` };
  }
  const baseRoles = computeRoles(rule.indicatorType, baseCandles, rule.indicatorParams || {});
  if (!baseRoles) {
    return { matched: false, value: null, threshold: null, reason: `indicador ${rule.indicatorType} no soportado` };
  }
  const idx = lastFiniteIndex(baseRoles, baseCandles);
  const labelL = `${rule.indicatorType.toUpperCase()}(${describeParams(rule.indicatorParams)})`;
  const op = rule.operator;

  // Operadores de estado / banda — no requieren operand
  if (op === 'squeeze_on' || op === 'squeeze_off') {
    const states = baseRoles.sqzState;
    if (!Array.isArray(states)) return { matched: false, value: null, threshold: null, reason: 'sqzmom requerido' };
    const state = states[idx];
    const matched = (op === 'squeeze_on') ? state === 'on' : state === 'off';
    return { matched, value: state, threshold: op, reason: `${labelL} state=${state}` };
  }
  if (op === 'momentum_positive' || op === 'momentum_negative') {
    const mom = baseRoles.sqzMomentum;
    if (!Array.isArray(mom)) return { matched: false, value: null, threshold: null, reason: 'sqzmom requerido' };
    const v = mom[idx];
    if (!Number.isFinite(v)) return { matched: false, value: v, threshold: 0, reason: 'momentum no disponible' };
    const matched = op === 'momentum_positive' ? v > 0 : v < 0;
    return { matched, value: v, threshold: 0, reason: `momentum=${fmt(v)}` };
  }
  if (op === 'momentum_redirect_bullish' || op === 'momentum_redirect_bearish') {
    const mom = baseRoles.sqzMomentum;
    if (!Array.isArray(mom)) return { matched: false, value: null, threshold: null, reason: 'sqzmom requerido' };
    const direction = op === 'momentum_redirect_bullish' ? 'bullish' : 'bearish';
    const result = momentumRedirect(mom, idx, direction);
    if (!result.available) {
      return { matched: false, value: result.current ?? null, threshold: null, reason: 'momentum no disponible' };
    }
    const label = direction === 'bullish' ? 'redirección alcista' : 'redirección bajista';
    return {
      matched: result.matched,
      value: result.current,
      threshold: result.previous,
      reason: `${label}: ${fmt(result.beforePrevious)} -> ${fmt(result.previous)} -> ${fmt(result.current)}`,
    };
  }
  if (op === 'above_upper' || op === 'below_lower' || op === 'above_middle' || op === 'below_middle') {
    const close = Number(baseCandles[idx]?.close);
    const refRole = op.endsWith('upper') ? 'upper' : op.endsWith('lower') ? 'lower' : 'middle';
    const refSeries = baseRoles[refRole];
    if (!Array.isArray(refSeries)) return { matched: false, value: close, threshold: null, reason: `no hay banda ${refRole}` };
    const refVal = refSeries[idx];
    if (!Number.isFinite(refVal)) return { matched: false, value: close, threshold: null, reason: 'banda no disponible' };
    const matched = op.startsWith('above') ? close > refVal : close < refVal;
    return { matched, value: close, threshold: refVal, reason: `precio ${fmt(close)} vs ${refRole} ${fmt(refVal)}` };
  }

  // Resto de operadores: necesitan leer leftSeries vía operandSeries
  const leftRole = rule.operandSeries || defaultRoleFor(rule.indicatorType);
  const leftSeries = getRoleSeries(baseRoles, leftRole, baseCandles);
  if (!Array.isArray(leftSeries)) {
    return { matched: false, value: null, threshold: null, reason: `role ${leftRole} no disponible` };
  }
  const leftVal = leftSeries[idx];

  if (op === 'between') {
    const lo = Number(rule.operand?.lower);
    const hi = Number(rule.operand?.upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(leftVal)) {
      return { matched: false, value: leftVal, threshold: { lo, hi }, reason: 'rango inválido' };
    }
    const matched = leftVal >= lo && leftVal <= hi;
    return { matched, value: leftVal, threshold: { lo, hi }, reason: `${fmt(leftVal)} en [${fmt(lo)},${fmt(hi)}]` };
  }

  // Construir RHS según operand kind
  const operand = rule.operand || { kind: 'constant', value: 0 };
  let rightSeries = null;
  let rightLabel = '';
  let rightVal = null;
  if (operand.kind === 'constant') {
    const v = Number(operand.value);
    rightSeries = leftSeries.map(() => v);
    rightVal = v;
    rightLabel = String(v);
  } else if (operand.kind === 'price') {
    rightSeries = baseCandles.map((c) => Number(c.close));
    rightVal = rightSeries[idx];
    rightLabel = 'price';
  } else if (operand.kind === 'self_offset') {
    const offset = Math.max(1, Math.floor(Number(operand.offset) || 1));
    // RHS = mismo leftSeries pero "desplazado" hacia atrás N velas. En crossUp/Down
    // la comparación reciente es entre last bar y bar previo, así que el truco es
    // simplemente leer leftSeries[idx - offset] en cada posición:
    rightSeries = leftSeries.map((_, i) => leftSeries[i - offset]);
    rightVal = rightSeries[idx];
    rightLabel = `${labelL}.${leftRole}[-${offset}]`;
  } else if (operand.kind === 'series') {
    const tf = operand.timeframe || baseTf;
    const otherCandles = candlesByTf[tf];
    if (!Array.isArray(otherCandles)) {
      return { matched: false, value: leftVal, threshold: null, reason: `sin velas para ${tf}` };
    }
    const otherRoles = computeRoles(operand.indicatorType, otherCandles, operand.indicatorParams || {});
    const otherRole = operand.operandSeries || defaultRoleFor(operand.indicatorType);
    const otherSeries = otherRoles ? getRoleSeries(otherRoles, otherRole, otherCandles) : null;
    if (!Array.isArray(otherSeries)) {
      return { matched: false, value: leftVal, threshold: null, reason: `RHS ${operand.indicatorType}.${otherRole} no disponible` };
    }
    // Realineación temporal: si los TFs difieren, mapear cada candle del lado
    // izquierdo al cierre más reciente del lado derecho ≤ candle.closeTime.
    rightSeries = (tf === baseTf)
      ? otherSeries
      : alignSeries(baseCandles, otherCandles, otherSeries);
    rightVal = rightSeries[idx];
    rightLabel = `${operand.indicatorType.toUpperCase()}(${describeParams(operand.indicatorParams)})${tf !== baseTf ? `@${tf}` : ''}.${otherRole}`;
  } else {
    return { matched: false, value: leftVal, threshold: null, reason: `operand kind '${operand.kind}' no soportado` };
  }

  if (op === 'cross_up' || op === 'cross_down') {
    const matched = op === 'cross_up'
      ? crossUp(leftSeries, rightSeries, idx)
      : crossDown(leftSeries, rightSeries, idx);
    const arrow = op === 'cross_up' ? '↗' : '↘';
    return {
      matched,
      value: leftVal,
      threshold: rightVal,
      reason: `${labelL}.${leftRole} ${arrow} ${rightLabel} (${fmt(leftVal)}/${fmt(rightVal)})`,
    };
  }

  // Numeric comparison
  const matched = numericCompare(leftVal, rightVal, op);
  return {
    matched,
    value: leftVal,
    threshold: rightVal,
    reason: `${labelL}.${leftRole} ${op} ${rightLabel} (${fmt(leftVal)} ${op} ${fmt(rightVal)})`,
  };
}

function alignSeries(baseCandles, otherCandles, otherSeries) {
  // Para cada baseCandle, encuentra el último otherCandle con closeTime ≤ base.closeTime
  // y devuelve el valor del otherSeries en ese índice. otherCandles ordenado asc.
  const out = new Array(baseCandles.length).fill(null);
  let j = 0;
  for (let i = 0; i < baseCandles.length; i += 1) {
    const ts = Number(baseCandles[i].closeTime ?? baseCandles[i].time);
    while (j + 1 < otherCandles.length && Number(otherCandles[j + 1].closeTime ?? otherCandles[j + 1].time) <= ts) {
      j += 1;
    }
    out[i] = otherSeries[j];
  }
  return out;
}

function describeParams(params) {
  if (!params || typeof params !== 'object') return '';
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

module.exports = {
  SUPPORTED_INDICATORS,
  ROLES_BY_INDICATOR,
  DEFAULT_ROLE,
  computeRoles,
  evaluateCondition,
  evaluateRule,
  normalizeRule,
};
