/**
 * Protective put: compra una put (|Δ|≈objetivo) que cubre una tenencia spot
 * declarada y la renueva (roll) unos días antes del vencimiento.
 */

const {
  FIELDS, hold, skip, pickLegByDelta, entryWindow, legFromChain,
  closeLegs, hoursToExpiry,
} = require('./helpers');

const id = 'protective_put';

const defaultParams = {
  holdingQty: 0.1,
  targetDelta: 0.25,
  expiryDays: 30,
  entryWeekday: null,
  entryHourUtc: null,
  rollDaysBeforeExpiry: 5,
};

const paramSchema = [
  FIELDS.holdingQty,
  FIELDS.targetDelta,
  FIELDS.expiryDays,
  FIELDS.entryWeekday,
  FIELDS.entryHourUtc,
  { key: 'rollDaysBeforeExpiry', label: 'Renovar antes del vencimiento', type: 'number', min: 0, max: 60, step: 1, unit: 'días' },
];

function buyPut(ctx, reason, detailPrefix) {
  const { spot, chain, params } = ctx;
  if (!chain || !chain.rows?.length) return skip('no_chain', 'Sin cadena para el vencimiento objetivo');
  const put = pickLegByDelta(chain, 'P', params.targetDelta, spot, 'ask');
  if (!put) return skip('no_legs', 'No hay put OTM con ask para la delta objetivo');
  return {
    type: 'open',
    reason,
    detail: `${detailPrefix} ${put.strike}P para ${params.holdingQty} de tenencia`,
    legs: [legFromChain(put, { side: 'BUY', quantity: params.holdingQty, type: 'P', expiry: chain.expiry })],
  };
}

function evaluate(ctx) {
  const { now, positions = [], params, lastOpenedAt } = ctx;
  if (!(params.holdingQty > 0)) return [skip('no_holding', 'Sin tenencia spot declarada')];

  if (positions.length) {
    const minHours = Math.min(...positions.map((p) => hoursToExpiry(p, now)));
    if (minHours > params.rollDaysBeforeExpiry * 24) {
      return [hold('protected', `Protegido: quedan ${(minHours / 24).toFixed(1)} días`)];
    }
    const close = {
      type: 'close',
      reason: 'roll',
      detail: `Roll: quedan ${(minHours / 24).toFixed(1)} días al vencimiento`,
      legs: closeLegs(positions),
    };
    const reopen = buyPut(ctx, 'roll', 'Renueva con');
    // Si no hay put nueva disponible, se mantiene la actual en vez de quedar sin cobertura.
    if (reopen.type !== 'open') return [hold('roll_pending', `Roll pendiente: ${reopen.detail}`)];
    return [close, reopen];
  }

  const window = entryWindow(now, params, lastOpenedAt);
  if (!window.open) return [skip('outside_window', window.detail)];
  return [buyPut(ctx, 'entry', 'Compra')];
}

module.exports = {
  id,
  label: 'Protective put',
  description: 'Compra puts para proteger una tenencia spot y las renueva antes de vencer.',
  holdsSpot: true,
  defaultParams,
  paramSchema,
  evaluate,
};
