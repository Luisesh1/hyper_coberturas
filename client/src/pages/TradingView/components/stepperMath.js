// Aritmética pura del stepper numérico del formulario de indicadores.
// Separada del componente para poder probar el redondeo y los límites sin DOM.

// Decimales de un número tal como se escribe (0.1 → 1, 0.05 → 2, 1 → 0).
function decimalsOf(n) {
  if (!Number.isFinite(n)) return 0;
  const [mantissa, exp] = String(n).toLowerCase().split('e');
  const frac = (mantissa.split('.')[1] || '').length;
  return Math.max(0, frac - Number(exp || 0));
}

function validStep(step) {
  return Number.isFinite(step) && step > 0 ? step : 1;
}

// Redondea al múltiplo de `step` más cercano y recorta los decimales al
// número que tiene el paso: así 0.1 + 0.2 sale 0.3 y no 0.30000000000000004.
function roundToStep(value, step) {
  const s = validStep(step);
  const snapped = Math.round(value / s) * s;
  return Number(snapped.toFixed(decimalsOf(s)));
}

function clamp(value, min, max) {
  let v = value;
  if (Number.isFinite(min) && v < min) v = min;
  if (Number.isFinite(max) && v > max) v = max;
  return v;
}

// Valor final que se guarda al confirmar (blur/Enter): en rango y en el paso.
export function normalizeNumber(value, { min, max, step } = {}) {
  return clamp(roundToStep(value, step), min, max);
}

// Pulsación de − / +: `direction` es -1 o 1.
export function stepNumber(value, direction, spec = {}) {
  const s = validStep(spec.step);
  const base = clamp(Number.isFinite(value) ? value : 0, spec.min, spec.max);
  return normalizeNumber(base + direction * s, spec);
}

// Texto del input → número, o null si todavía no es un número completo
// ('' , '-', '1.'). Acepta coma decimal porque los teclados en español la usan.
export function parseNumberInput(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
