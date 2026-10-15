// Normalización y validación del `paramSchema` de las plantillas de
// estrategia (GET /options/strategies/templates). El servidor puede mandarlo
// como lista `[{ key, label, type, min, max, step, ... }]` o como objeto
// `{ key: { label, type, ... } }`; aquí se reduce a una lista uniforme para
// que el formulario no dependa de la grafía exacta.

const NUMBER_TYPES = new Set(['number', 'float', 'decimal', 'percent', 'usdt']);
const INTEGER_TYPES = new Set(['integer', 'int']);
const BOOLEAN_TYPES = new Set(['boolean', 'bool', 'switch']);
const SELECT_TYPES = new Set(['select', 'enum', 'choice']);

export function humanizeKey(key) {
  const text = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

const finite = (v) => (v === null || v === undefined || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined));

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => (o && typeof o === 'object'
    ? { value: o.value ?? o.id ?? o.key, label: String(o.label ?? o.value ?? o.id ?? o.key) }
    : { value: o, label: String(o) }));
}

function normalizeSpec(raw, fallbackKey) {
  const spec = raw && typeof raw === 'object' ? raw : {};
  const key = spec.key ?? spec.name ?? spec.id ?? fallbackKey;
  if (!key) return null;
  const rawType = String(spec.type || '').toLowerCase();
  const options = normalizeOptions(spec.options ?? spec.enum ?? spec.values);

  let type;
  if (BOOLEAN_TYPES.has(rawType)) type = 'boolean';
  else if (SELECT_TYPES.has(rawType) || (options.length && !rawType)) type = 'select';
  else if (INTEGER_TYPES.has(rawType)) type = 'integer';
  else if (NUMBER_TYPES.has(rawType)) type = 'number';
  else if (rawType === 'string' || rawType === 'text') type = 'text';
  else if (typeof spec.default === 'boolean') type = 'boolean';
  else type = 'number';

  const step = finite(spec.step) ?? (type === 'integer' ? 1 : undefined);
  return {
    key: String(key),
    label: spec.label || spec.title || humanizeKey(key),
    type,
    min: finite(spec.min ?? spec.minimum),
    max: finite(spec.max ?? spec.maximum),
    step,
    unit: spec.unit || spec.suffix || '',
    help: spec.help || spec.description || spec.hint || '',
    options,
    required: spec.required !== false,
    default: spec.default,
  };
}

export function normalizeSchema(schema) {
  if (!schema) return [];
  const list = Array.isArray(schema)
    ? schema.map((s) => normalizeSpec(s))
    : Object.entries(schema).map(([k, s]) => normalizeSpec(s, k));
  return list.filter(Boolean);
}

// Paso por defecto razonable para un número sin `step`: 1 si los límites o
// el valor son enteros grandes, 0,01 si es una magnitud pequeña.
export function effectiveStep(spec, value) {
  if (Number.isFinite(spec.step) && spec.step > 0) return spec.step;
  const ref = [spec.min, spec.max, value].filter((n) => Number.isFinite(n));
  const maxAbs = ref.length ? Math.max(...ref.map(Math.abs)) : 1;
  if (maxAbs <= 1) return 0.01;
  if (maxAbs <= 10) return 0.1;
  return 1;
}

// Valores iniciales: defaultParams de la plantilla, luego `default` del
// esquema, luego algo neutro según el tipo. `current` (edición) manda.
export function initialParams(template, current = {}) {
  const schema = normalizeSchema(template?.paramSchema);
  const defaults = template?.defaultParams || {};
  const values = { ...defaults };
  for (const spec of schema) {
    if (values[spec.key] !== undefined) continue;
    if (spec.default !== undefined) values[spec.key] = spec.default;
    else if (spec.type === 'boolean') values[spec.key] = false;
    else if (spec.type === 'select') values[spec.key] = spec.options[0]?.value;
    else if (spec.type === 'text') values[spec.key] = '';
    else values[spec.key] = Number.isFinite(spec.min) ? spec.min : 0;
  }
  return { ...values, ...(current || {}) };
}

const fmt = (n) => String(n).replace('.', ',');

// Errores por clave, en español. Vacío si todo es válido.
export function validateParams(schemaInput, values = {}) {
  // normalizeSchema es idempotente: acepta el esquema crudo o ya normalizado.
  const schema = normalizeSchema(schemaInput);
  const errors = {};
  for (const spec of schema) {
    const v = values[spec.key];
    if (spec.type === 'number' || spec.type === 'integer') {
      if (v === '' || v === null || v === undefined) {
        if (spec.required) errors[spec.key] = 'Obligatorio';
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors[spec.key] = 'Debe ser un número';
      } else if (spec.type === 'integer' && !Number.isInteger(n)) {
        errors[spec.key] = 'Debe ser un número entero';
      } else if (Number.isFinite(spec.min) && n < spec.min) {
        errors[spec.key] = `Mínimo ${fmt(spec.min)}${spec.unit ? ` ${spec.unit}` : ''}`;
      } else if (Number.isFinite(spec.max) && n > spec.max) {
        errors[spec.key] = `Máximo ${fmt(spec.max)}${spec.unit ? ` ${spec.unit}` : ''}`;
      }
    } else if (spec.type === 'select') {
      if (spec.required && (v === undefined || v === null || v === '')) errors[spec.key] = 'Elige una opción';
      else if (spec.options.length && v !== undefined && !spec.options.some((o) => String(o.value) === String(v))) {
        errors[spec.key] = 'Opción no válida';
      }
    } else if (spec.type === 'text') {
      if (spec.required && !String(v ?? '').trim()) errors[spec.key] = 'Obligatorio';
    }
  }
  return errors;
}

// Texto legible de un valor («0,2», «Sí», etiqueta de la opción…).
export function formatParamValue(spec, value) {
  if (value === undefined || value === null || value === '') return '—';
  if (spec.type === 'boolean') return value ? 'Sí' : 'No';
  if (spec.type === 'select') {
    const opt = spec.options.find((o) => String(o.value) === String(value));
    return opt ? opt.label : String(value);
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    const n = Number(value);
    const text = Number.isFinite(n) ? n.toLocaleString('es-ES', { maximumFractionDigits: 6 }) : String(value);
    return spec.unit ? `${text} ${spec.unit}` : text;
  }
  return String(value);
}
