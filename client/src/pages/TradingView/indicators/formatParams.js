import { INDICATORS } from './catalog';

// Resumen legible de los parámetros de un indicador activo, usando las
// etiquetas del esquema en lugar de las claves internas.
//
// Los interruptores «show…» se omiten: solo deciden qué líneas se pintan,
// no cambian el cálculo, y ya se ven en la propia gráfica. Mostrarlos
// gastaría el espacio de la línea en ruido («Mostrar ADX · Mostrar +DI…»).
const isDisplayToggle = (field) => field.type === 'boolean' && /^show[A-Z]/.test(field.key);

function describeField(field, value) {
  if (value == null) return null;
  if (field.type === 'boolean') return value === true ? field.label : null;
  return `${field.label} ${value}`;
}

// Por defecto 3 elementos + «+N»: así la línea cabe en ~2 renglones en un
// móvil de 390px en vez de partirse en tres.
export function formatParams(entry, { max = 3 } = {}) {
  const meta = INDICATORS[entry?.type];
  if (!meta) return '';
  const params = entry.params || {};
  const parts = (meta.paramSchema || [])
    .filter((field) => !isDisplayToggle(field))
    .map((field) => describeField(field, params[field.key]))
    .filter(Boolean);
  if (parts.length === 0) return meta.fullName;
  if (parts.length <= max) return parts.join(' · ');
  return [...parts.slice(0, max), `+${parts.length - max}`].join(' · ');
}
