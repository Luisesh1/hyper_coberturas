// Modos del editor de bots: Simple (lo esencial), Avanzado (todos los campos)
// y Presets (estilos que rellenan strike, vencimiento, salida y tiempo máximo). Todos
// escriben los mismos parámetros del bot: no hay nada nuevo en el servidor.
import { STRUCTURE_DEFAULTS, maxHoldText, perSignalBudget, withTakeProfitMode } from './botView';
import { formatNumber } from '../strategies/common/format';

export const EDITOR_MODES = [
  { value: 'simple', label: 'Simple' },
  { value: 'advanced', label: 'Avanzado' },
  { value: 'presets', label: 'Presets' },
];

export const STRIKE_OPTIONS = [
  // 0,95: ninguna OTM llega, así que gana la de mayor delta (la más cercana al spot).
  { value: 'near', label: 'Cercano', text: 'cercana al precio', delta: 0.95, help: 'La OTM más cercana al precio: más cara, se mueve más.' },
  { value: 'mid', label: 'Equilibrado', text: 'equilibrada', delta: 0.35, help: 'Algo alejada del precio (delta 0,35).' },
  { value: 'far', label: 'Lejano', text: 'lejana y barata', delta: 0.15, help: 'Barata y explosiva; suele vencer sin valor (delta 0,15).' },
];

export const EXPIRY_OPTIONS = [
  { value: 'short', label: '1–3 días', expiryDays: 2, expiryMinDays: 1, expiryMaxDays: 3, help: 'Para señales de 15 m a 1 h.' },
  { value: 'week', label: '~1 semana', expiryDays: 7, expiryMinDays: 5, expiryMaxDays: 9, help: 'Para señales de 4 h.' },
  { value: 'month', label: '~1 mes', expiryDays: 30, expiryMinDays: 21, expiryMaxDays: 40, help: 'Para señales diarias.' },
];

export const EXIT_OPTIONS = [
  { value: 'atr', label: 'Banda ATR' },
  { value: 'fixed', label: 'TP / SL fijo' },
];

// Tiempo máximo en posición en Simple (minutos; null = sin límite).
export const MAX_HOLD_OPTIONS = [
  { value: 'none', label: 'Sin límite', minutes: null },
  { value: '1h', label: '1 h', minutes: 60 },
  { value: '4h', label: '4 h', minutes: 240 },
  { value: '12h', label: '12 h', minutes: 720 },
  { value: '1d', label: '1 día', minutes: 1440 },
  { value: '3d', label: '3 días', minutes: 4320 },
];

export const PRESETS = [
  { value: 'fast', label: 'Rápido', desc: 'Para alertas de 15 m – 1 h. Entra cerca del precio y vende en la banda ATR.',
    strike: 'near', expiry: 'short', exit: 'atr', tpMaxGainPct: 200, maxHoldMinutes: 240 },
  { value: 'swing', label: 'Swing', desc: 'Para alertas de 4 h – 1 d. Más plazo y salidas fijas.',
    strike: 'mid', expiry: 'week', exit: 'fixed', maxHoldMinutes: 4320 },
  { value: 'lottery', label: 'Lotería', desc: 'Opciones baratas y lejanas: pocas aciertan, pero pagan mucho.',
    strike: 'far', expiry: 'short', exit: 'atr', tpMaxGainPct: 500, maxHoldMinutes: null },
];

// Con «Riesgo por operación» manda el capital: la cantidad máxima sube hasta
// aquí para no recortarlo (sigue siendo un tope de seguridad).
export const RISK_QUANTITY_CAP = 1;

// Campos que el modo Simple muestra con su error.
const SIMPLE_ERROR_KEYS = ['name', 'underlyings', 'alertIds', 'capitalUsdt'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const same = (a, b) => num(a) !== null && Math.abs(num(a) - b) < 1e-9;
const isBuy = (form) => form.structure !== 'sell_against';

export const strikeOf = (form) => STRIKE_OPTIONS.find((o) => same(form.targetDelta, o.delta))?.value ?? null;

export function withStrike(form, value) {
  const opt = STRIKE_OPTIONS.find((o) => o.value === value);
  return opt ? { ...form, targetDelta: opt.delta } : form;
}

export const expiryOf = (form) => EXPIRY_OPTIONS.find((o) => same(form.expiryDays, o.expiryDays)
  && same(form.expiryMinDays, o.expiryMinDays) && same(form.expiryMaxDays, o.expiryMaxDays))?.value ?? null;

export function withExpiry(form, value) {
  const opt = EXPIRY_OPTIONS.find((o) => o.value === value);
  if (!opt) return form;
  return { ...form, expiryDays: opt.expiryDays, expiryMinDays: opt.expiryMinDays, expiryMaxDays: opt.expiryMaxDays };
}

export function exitOf(form) {
  if (form.takeProfitMode === 'atr_band') return 'atr';
  if (form.takeProfitMode === 'fixed') return 'fixed';
  return null;
}

export function withExit(form, value) {
  if (value === 'atr' && isBuy(form)) return withTakeProfitMode(form, 'atr_band');
  if (value === 'fixed') return withTakeProfitMode(form, 'fixed');
  return form;
}

const holdMinutes = (form) => (num(form.maxHoldMinutes) > 0 ? num(form.maxHoldMinutes) : null);

export const maxHoldOf = (form) => MAX_HOLD_OPTIONS.find((o) => o.minutes === holdMinutes(form))?.value ?? null;

export function withMaxHold(form, value) {
  const opt = MAX_HOLD_OPTIONS.find((o) => o.value === value);
  return opt ? { ...form, maxHoldMinutes: opt.minutes } : form;
}

// Banda ATR solo existe al comprar: al vender, los presets salen con TP/SL fijo.
const presetExit = (preset, form) => (isBuy(form) ? preset.exit : 'fixed');

function presetExtras(preset, form) {
  if (presetExit(preset, form) === 'atr') return { tpMaxGainPct: preset.tpMaxGainPct };
  const d = STRUCTURE_DEFAULTS[isBuy(form) ? 'buy_with' : 'sell_against'];
  return { takeProfitPct: d.takeProfitPct, stopLossPct: d.stopLossPct };
}

export function applyPreset(form, value) {
  const preset = PRESETS.find((p) => p.value === value);
  if (!preset) return form;
  const next = withExit(withExpiry(withStrike(form, preset.strike), preset.expiry), presetExit(preset, form));
  return { ...next, ...presetExtras(preset, next), maxHoldMinutes: preset.maxHoldMinutes };
}

export function presetOf(form) {
  return PRESETS.find((p) => strikeOf(form) === p.strike && expiryOf(form) === p.expiry
    && exitOf(form) === presetExit(p, form)
    && holdMinutes(form) === p.maxHoldMinutes
    && Object.entries(presetExtras(p, form)).every(([k, v]) => same(form[k], v)))?.value ?? null;
}

export function withRisk(form, value) {
  const quantity = Number(form.quantity) >= RISK_QUANTITY_CAP ? form.quantity : RISK_QUANTITY_CAP;
  return { ...form, capitalUsdt: value, quantity };
}

const usdt = (v) => `${formatNumber(v, { decimals: 2, minDecimals: 0 })} USDT`;

function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} o ${items[items.length - 1]}`;
}

function riskText(form) {
  const perSignal = perSignalBudget(form);
  if (perSignal !== null) return `con hasta ${usdt(perSignal)} del presupuesto por señal`;
  if (num(form.capitalUsdt) > 0) return `arriesgando hasta ${usdt(num(form.capitalUsdt))}`;
  return 'con la cantidad configurada';
}

function exitText(form) {
  const m = holdMinutes(form);
  const hold = m === null ? '' : ` Cierra como máximo tras ${maxHoldText(m)} en posición.`;
  if (form.takeProfitMode === 'atr_band') return `Vende al tocar la banda ATR.${hold}`;
  if (form.takeProfitMode === 'volatility') return `Sale con TP por volatilidad o stop.${hold}`;
  return `Sale con TP +${formatNumber(form.takeProfitPct, { decimals: 0 })} % o stop −${formatNumber(form.stopLossPct, { decimals: 0 })} %.${hold}`;
}

// Etiquetas de un preset tal como quedaría con la estructura del formulario.
export function presetTags(preset, form) {
  const strike = STRIKE_OPTIONS.find((o) => o.value === preset.strike);
  const expiry = EXPIRY_OPTIONS.find((o) => o.value === preset.expiry);
  const exit = presetExit(preset, form) === 'atr' ? `Banda ATR · tope +${preset.tpMaxGainPct} %` : 'TP / SL fijo';
  const hold = preset.maxHoldMinutes ? `Máx. ${maxHoldText(preset.maxHoldMinutes)} en posición` : 'Sin tiempo máximo';
  return [`Strike ${strike.label.toLowerCase()}`, expiry.label, exit, hold];
}

// Ayudas de los campos de Simple; sin opción equivalente, «Personalizado».
export function strikeHelp(form) {
  const opt = STRIKE_OPTIONS.find((o) => o.value === strikeOf(form));
  return opt ? opt.help : `Personalizado: delta ${formatNumber(form.targetDelta, { decimals: 2, minDecimals: 0 })}. Ajústalo en Avanzado.`;
}

export function expiryHelp(form) {
  const opt = EXPIRY_OPTIONS.find((o) => o.value === expiryOf(form));
  if (opt) return opt.help;
  const range = num(form.expiryMinDays) !== null && num(form.expiryMaxDays) !== null
    ? ` (${num(form.expiryMinDays)}–${num(form.expiryMaxDays)})` : '';
  return `Personalizado: ${formatNumber(form.expiryDays, { decimals: 0 })} días${range}. Ajústalo en Avanzado.`;
}

export function exitHelp(form) {
  if (form.takeProfitMode === 'atr_band') return 'Vende al tocar la banda ATR. Sin stop.';
  if (form.takeProfitMode === 'fixed') {
    return `TP +${formatNumber(form.takeProfitPct, { decimals: 0 })} % · stop −${formatNumber(form.stopLossPct, { decimals: 0 })} % de la prima. Ajústalos en Avanzado.`;
  }
  return 'Personalizado: TP por volatilidad. Ajústalo en Avanzado.';
}

export function maxHoldHelp(form) {
  const m = holdMinutes(form);
  if (m === null) return 'Sigue abierta hasta TP, stop, señal contraria o vencimiento.';
  if (!maxHoldOf(form)) return `Personalizado: ${maxHoldText(m)}. Ajústalo en Avanzado.`;
  const atr = form.takeProfitMode === 'atr_band' ? ' (antes se cancela el TP de la banda)' : '';
  return `Si lleva ${maxHoldText(m)} abierta, se cierra al precio de mercado${atr}.`;
}

// Lo que hará el bot, en una frase (se muestra en Simple y Presets).
export function botSummary(form) {
  const strike = STRIKE_OPTIONS.find((o) => o.value === strikeOf(form));
  const expiry = EXPIRY_OPTIONS.find((o) => o.value === expiryOf(form));
  const action = isBuy(form)
    ? 'compra la opción a favor (call si es alcista, put si es bajista)'
    : 'vende la opción en contra (put si es alcista, call si es bajista)';
  const strikeTxt = strike ? strike.text : `con delta ${formatNumber(form.targetDelta, { decimals: 2, minDecimals: 0 })}`;
  const expiryTxt = expiry ? expiry.label : `~${formatNumber(form.expiryDays, { decimals: 0 })} días`;
  return `Con cada alerta en ${listText(form.underlyings || [])} ${action}, ${strikeTxt}, que vence en ${expiryTxt}, ${riskText(form)}. ${exitText(form)}`;
}

// Modo en el que el usuario puede ver todos los errores de validación.
export function errorMode(errors, mode) {
  const keys = Object.keys(errors || {});
  if (!keys.length) return mode;
  return keys.every((k) => SIMPLE_ERROR_KEYS.includes(k)) && mode !== 'advanced' ? 'simple' : 'advanced';
}
