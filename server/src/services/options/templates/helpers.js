/**
 * Ayudas puras para los templates: selección de patas por delta, ventana de
 * entrada, IV ATM, cierre de posiciones y validación de parámetros.
 */

const { ValidationError } = require('../../../errors/app-error');
const { HOUR_MS, ivToDecimal, num, oppositeSide } = require('../options-utils');

// Tras abrir, no se vuelve a entrar en la misma ventana diaria.
const MIN_HOURS_BETWEEN_ENTRIES = 20;

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function hold(reason, detail) {
  return { type: 'hold', reason, detail };
}

function skip(reason, detail) {
  return { type: 'skip', reason, detail };
}

/** Vencimiento cuyo `dte` está más cerca de `targetDays` (descarta los de menos de medio día). */
function pickExpiry(expiries, targetDays) {
  const candidates = (expiries || []).filter((e) => Number(e.dte) >= 0.5);
  if (!candidates.length) return null;
  return candidates.reduce((best, e) => (
    Math.abs(Number(e.dte) - targetDays) < Math.abs(Number(best.dte) - targetDays) ? e : best
  ));
}

/**
 * Pata OTM cuya delta está más cerca de `targetAbsDelta` (en valor absoluto).
 * `need` = 'bid' para vender, 'ask' para comprar: sin precio no hay pata.
 */
function pickLegByDelta(chain, type, targetAbsDelta, spot, need) {
  let best = null;
  for (const row of chain?.rows || []) {
    const leg = type === 'C' ? row.call : row.put;
    if (!leg) continue;
    const strike = Number(row.strike);
    if (type === 'C' && !(strike > spot)) continue;
    if (type === 'P' && !(strike < spot)) continue;
    const delta = num(leg.delta);
    const price = num(leg[need]);
    if (delta == null || price == null || price <= 0) continue;
    const distance = Math.abs(Math.abs(delta) - targetAbsDelta);
    if (!best || distance < best.distance) best = { leg, strike, distance };
  }
  return best;
}

/** IV ATM (decimal): media de call y put del strike más cercano al spot. */
function atmIv(chain, spot) {
  let nearest = null;
  for (const row of chain?.rows || []) {
    if (!nearest || Math.abs(row.strike - spot) < Math.abs(nearest.strike - spot)) nearest = row;
  }
  if (!nearest) return null;
  const ivs = [ivToDecimal(nearest.call?.iv), ivToDecimal(nearest.put?.iv)].filter((v) => v != null);
  if (!ivs.length) return null;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/** ¿Toca entrar ahora? Respeta día de la semana y hora UTC si están fijados. */
function entryWindow(now, params, lastOpenedAt) {
  const date = new Date(now);
  if (params.entryWeekday != null && date.getUTCDay() !== Number(params.entryWeekday)) {
    return { open: false, detail: `Solo entra los ${WEEKDAYS[params.entryWeekday]}` };
  }
  if (params.entryHourUtc != null && date.getUTCHours() !== Number(params.entryHourUtc)) {
    return { open: false, detail: `Solo entra a las ${String(params.entryHourUtc).padStart(2, '0')}:00 UTC` };
  }
  if (lastOpenedAt && now - lastOpenedAt < MIN_HOURS_BETWEEN_ENTRIES * HOUR_MS) {
    return { open: false, detail: 'Ya entró en esta ventana' };
  }
  return { open: true };
}

function legFromChain(pick, { side, quantity, type, expiry }) {
  return {
    symbol: pick.leg.symbol,
    side,
    quantity,
    strike: pick.strike,
    optionType: type,
    expiry,
    price: num(side === 'SELL' ? pick.leg.bid : pick.leg.ask),
    delta: num(pick.leg.delta),
    iv: ivToDecimal(pick.leg.iv),
  };
}

function closeLegs(positions) {
  return positions.map((p) => ({
    positionId: p.id,
    symbol: p.symbol,
    side: oppositeSide(p.side),
    quantity: p.quantity,
  }));
}

/** Coste (o ingreso) de cerrar: recomprar al ask lo vendido, vender al bid lo comprado. */
function closeValue(position) {
  const q = position.quote || {};
  const price = position.side === 'SELL'
    ? (num(q.ask) > 0 ? num(q.ask) : num(q.mark))
    : (num(q.bid) > 0 ? num(q.bid) : num(q.mark));
  return price == null ? null : price * position.quantity;
}

function hoursToExpiry(position, now) {
  return (position.expiryMs - now) / HOUR_MS;
}

/**
 * Valida y completa los parámetros contra el `paramSchema` del template.
 * Devuelve un objeto nuevo con los valores por defecto aplicados.
 */
function validateParams(template, raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const field of template.paramSchema) {
    const value = input[field.key] === undefined ? template.defaultParams[field.key] : input[field.key];
    if (value == null || value === '') {
      if (!field.nullable) throw new ValidationError(`${field.label}: es obligatorio`);
      out[field.key] = null;
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw new ValidationError(`${field.label}: debe ser un número`);
    if (field.integer && !Number.isInteger(n)) throw new ValidationError(`${field.label}: debe ser entero`);
    if (field.min != null && n < field.min) throw new ValidationError(`${field.label}: mínimo ${field.min}`);
    if (field.max != null && n > field.max) throw new ValidationError(`${field.label}: máximo ${field.max}`);
    out[field.key] = n;
  }
  return out;
}

// Campos comunes de paramSchema.
const FIELDS = {
  quantity: { key: 'quantity', label: 'Cantidad por pata', type: 'number', min: 0.0001, max: 1000, step: 0.01, unit: 'subyacente' },
  holdingQty: { key: 'holdingQty', label: 'Tenencia spot declarada', type: 'number', min: 0.0001, max: 1e6, step: 0.01, unit: 'subyacente' },
  targetDelta: { key: 'targetDelta', label: 'Delta objetivo (|Δ|)', type: 'number', min: 0.01, max: 0.5, step: 0.01 },
  expiryDays: { key: 'expiryDays', label: 'Vencimiento objetivo', type: 'number', integer: true, min: 1, max: 180, step: 1, unit: 'días' },
  entryWeekday: { key: 'entryWeekday', label: 'Día de entrada', type: 'weekday', integer: true, min: 0, max: 6, nullable: true },
  entryHourUtc: { key: 'entryHourUtc', label: 'Hora de entrada (UTC)', type: 'hour', integer: true, min: 0, max: 23, nullable: true },
  takeProfitPct: { key: 'takeProfitPct', label: 'Take profit', type: 'number', min: 1, max: 100, step: 1, unit: '% de la prima' },
  exitHoursBeforeExpiry: { key: 'exitHoursBeforeExpiry', label: 'Salida antes del vencimiento', type: 'number', min: 0, max: 720, step: 1, unit: 'horas' },
};

module.exports = {
  MIN_HOURS_BETWEEN_ENTRIES,
  FIELDS,
  hold,
  skip,
  pickExpiry,
  pickLegByDelta,
  atmIv,
  entryWindow,
  legFromChain,
  closeLegs,
  closeValue,
  hoursToExpiry,
  validateParams,
};
