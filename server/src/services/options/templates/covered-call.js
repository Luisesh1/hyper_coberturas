/**
 * Covered call: vende una call OTM (Δ≈objetivo) contra una tenencia spot
 * declarada. La cantidad vendida es la tenencia: nunca queda descubierta.
 * Sale por take profit o por tiempo; con salida 0 h la deja vencer.
 */

const {
  FIELDS, hold, skip, pickLegByDelta, entryWindow, legFromChain,
  closeLegs, closeValue, hoursToExpiry,
} = require('./helpers');

const id = 'covered_call';

const defaultParams = {
  holdingQty: 0.1,
  targetDelta: 0.25,
  expiryDays: 7,
  entryWeekday: 5,
  entryHourUtc: 9,
  takeProfitPct: 80,
  exitHoursBeforeExpiry: 0,
};

const paramSchema = [
  FIELDS.holdingQty,
  FIELDS.targetDelta,
  FIELDS.expiryDays,
  FIELDS.entryWeekday,
  FIELDS.entryHourUtc,
  FIELDS.takeProfitPct,
  FIELDS.exitHoursBeforeExpiry,
];

function evaluate(ctx) {
  const { now, spot, chain, positions = [], params, lastOpenedAt } = ctx;

  if (positions.length) {
    const legs = closeLegs(positions);
    const minHours = Math.min(...positions.map((p) => hoursToExpiry(p, now)));
    if (params.exitHoursBeforeExpiry > 0 && minHours <= params.exitHoursBeforeExpiry) {
      return [{ type: 'close', reason: 'time_exit', detail: `Salida por tiempo: quedan ${minHours.toFixed(1)} h`, legs }];
    }
    const premium = positions.reduce((acc, p) => acc + p.entryPrice * p.quantity, 0);
    const values = positions.map(closeValue);
    if (values.some((v) => v == null)) return [hold('no_quote', 'Sin cotización para valorar la call')];
    const pnlPct = premium > 0 ? ((premium - values.reduce((a, b) => a + b, 0)) / premium) * 100 : 0;
    if (pnlPct >= params.takeProfitPct) {
      return [{ type: 'close', reason: 'take_profit', detail: `Take profit: ${pnlPct.toFixed(1)} % de la prima`, legs }];
    }
    return [hold('in_position', `Call vendida: ${pnlPct.toFixed(1)} % de la prima`)];
  }

  const window = entryWindow(now, params, lastOpenedAt);
  if (!window.open) return [skip('outside_window', window.detail)];
  if (!chain || !chain.rows?.length) return [skip('no_chain', 'Sin cadena para el vencimiento objetivo')];
  if (!(params.holdingQty > 0)) return [skip('no_holding', 'Sin tenencia spot declarada')];

  const call = pickLegByDelta(chain, 'C', params.targetDelta, spot, 'bid');
  if (!call) return [skip('no_legs', 'No hay call OTM con bid para la delta objetivo')];

  return [{
    type: 'open',
    reason: 'entry',
    detail: `Vende ${call.strike}C cubierta por ${params.holdingQty} de tenencia`,
    legs: [legFromChain(call, { side: 'SELL', quantity: params.holdingQty, type: 'C', expiry: chain.expiry })],
  }];
}

module.exports = {
  id,
  label: 'Covered call',
  description: 'Vende calls fuera del dinero contra una tenencia spot.',
  holdsSpot: true,
  defaultParams,
  paramSchema,
  evaluate,
};
