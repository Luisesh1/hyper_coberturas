import { emptyCondition } from '../components/AlertRuleRow';
import { normalizeDirection } from './direction';

const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];

export function emptyRule() {
  return {
    id: `r-${Math.random().toString(36).slice(2, 9)}`,
    label: '',
    conditions: [emptyCondition()],
    joiners: [],
    weight: 1,
  };
}

function normalizeRuleWeight(value) {
  if (value == null || value === '') return 1;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 1;
}

// Normaliza una regla cargada desde el server (que puede ser legacy plana o
// la nueva forma con conditions/joiners) a la forma que espera el editor.
export function normalizeLoadedRule(raw) {
  const base = { ...emptyRule() };
  if (raw && Array.isArray(raw.conditions) && raw.conditions.length > 0) {
    return {
      ...base,
      label: String(raw.label || ''),
      conditions: raw.conditions.map((c) => ({ ...emptyCondition(), ...c })),
      joiners: Array.isArray(raw.joiners) ? raw.joiners.slice() : [],
      weight: normalizeRuleWeight(raw.weight),
    };
  }
  if (raw && raw.indicatorType) {
    const cond = {
      indicatorType: raw.indicatorType,
      indicatorParams: { ...(raw.indicatorParams || {}) },
      timeframe: raw.timeframe,
      operandSeries: raw.operandSeries,
      operator: raw.operator,
      operand: raw.operand ? { ...raw.operand } : { kind: 'constant', value: 0 },
    };
    return { ...base, label: String(raw.label || ''), conditions: [cond], joiners: [], weight: normalizeRuleWeight(raw.weight) };
  }
  return base;
}

export function formToPayload(value) {
  return {
    name: value.name.trim(),
    isActive: value.isActive,
    thresholdPercent: Number(value.thresholdPercent),
    cooldownSeconds: Number(value.cooldownSeconds),
    telegramEnabled: value.telegramEnabled,
    datasource: value.datasource,
    direction: normalizeDirection(value.direction),
    assetList: value.assetList.slice(),
    rules: value.rules.map((r) => ({
      label: String(r.label || '').trim(),
      conditions: (r.conditions || []).map((c) => ({
        indicatorType: c.indicatorType,
        indicatorParams: c.indicatorParams || {},
        timeframe: c.timeframe,
        operandSeries: c.operandSeries,
        operator: c.operator,
        operand: c.operand,
      })),
      joiners: r.joiners || [],
      weight: Number(r.weight) || 0,
    })),
  };
}

// DTO del servidor → payload para `alertsApi.update` (misma forma que el editor).
export function alertToPayload(alert) {
  return formToPayload({
    ...alert,
    name: String(alert.name ?? ''),
    assetList: Array.isArray(alert.assetList) ? alert.assetList : [],
    rules: (Array.isArray(alert.rules) ? alert.rules : []).map(normalizeLoadedRule),
  });
}

// Temporalidad más baja de las condiciones y de los operandos `series`
// (mismo criterio que el servidor). null si no hay ninguna.
export function baseTimeframe(rules) {
  const tfs = (Array.isArray(rules) ? rules : [])
    .flatMap((r) => r?.conditions || [])
    .flatMap((c) => [c.timeframe, c.operand?.kind === 'series' ? c.operand.timeframe : null])
    .filter((tf) => TF_ORDER.includes(tf))
    .sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
  return tfs[0] || null;
}

const pad = (n) => String(n).padStart(2, '0');

// «Pausada» | «Nunca» | «hoy 12:00» | «ayer 18:15» | «dd/mm hh:mm».
export function lastTriggeredLabel(alert, now = Date.now()) {
  if (!alert?.isActive) return 'Pausada';
  const times = Object.values(alert.lastTriggeredAt || {}).map(Number).filter((t) => Number.isFinite(t) && t > 0);
  if (times.length === 0) return 'Nunca';
  const d = new Date(Math.max(...times));
  const today = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(today) - startOf(d)) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayDiff === 0) return `hoy ${hm}`;
  if (dayDiff === 1) return `ayer ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}
