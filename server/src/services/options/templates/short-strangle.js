/**
 * Short strangle: vende una call con Δ≈+objetivo y una put con Δ≈−objetivo
 * al vencimiento más cercano a N días. Sale por take profit, stop (pérdida en
 * % de la prima o |Δ| de una pata) o por tiempo antes del vencimiento.
 */

const {
  FIELDS, hold, skip, pickLegByDelta, atmIv, entryWindow, legFromChain,
  closeLegs, closeValue, hoursToExpiry,
} = require('./helpers');
const { num } = require('../options-utils');

const id = 'short_strangle';

const defaultParams = {
  quantity: 0.01,
  targetDelta: 0.15,
  expiryDays: 7,
  entryWeekday: 5,
  entryHourUtc: 9,
  minAtmIvPct: 35,
  takeProfitPct: 50,
  stopLossPct: 200,
  maxLegDelta: 0.4,
  exitHoursBeforeExpiry: 6,
};

const paramSchema = [
  FIELDS.quantity,
  FIELDS.targetDelta,
  FIELDS.expiryDays,
  FIELDS.entryWeekday,
  FIELDS.entryHourUtc,
  { key: 'minAtmIvPct', label: 'IV ATM mínima', type: 'number', min: 0, max: 500, step: 1, unit: '%' },
  FIELDS.takeProfitPct,
  { key: 'stopLossPct', label: 'Stop por pérdida', type: 'number', min: 10, max: 1000, step: 10, unit: '% de la prima' },
  { key: 'maxLegDelta', label: 'Stop por |Δ| de una pata', type: 'number', min: 0.05, max: 1, step: 0.01 },
  FIELDS.exitHoursBeforeExpiry,
];

function manage(ctx) {
  const { now, positions, params } = ctx;
  const legs = closeLegs(positions);
  const minHours = Math.min(...positions.map((p) => hoursToExpiry(p, now)));
  if (minHours <= params.exitHoursBeforeExpiry) {
    return [{ type: 'close', reason: 'time_exit', detail: `Salida por tiempo: quedan ${minHours.toFixed(1)} h al vencimiento`, legs }];
  }

  const premium = positions.reduce((acc, p) => acc + p.entryPrice * p.quantity, 0);
  const values = positions.map(closeValue);
  if (values.some((v) => v == null)) return [hold('no_quote', 'Sin cotización para valorar las patas')];
  const costToClose = values.reduce((a, b) => a + b, 0);
  const pnlPct = premium > 0 ? ((premium - costToClose) / premium) * 100 : 0;

  if (pnlPct >= params.takeProfitPct) {
    return [{ type: 'close', reason: 'take_profit', detail: `Take profit: ${pnlPct.toFixed(1)} % de la prima`, legs }];
  }
  if (-pnlPct >= params.stopLossPct) {
    return [{ type: 'close', reason: 'stop_loss', detail: `Stop: pérdida del ${(-pnlPct).toFixed(1)} % de la prima`, legs }];
  }
  const breached = positions.find((p) => Math.abs(num(p.quote?.delta) ?? 0) >= params.maxLegDelta);
  if (breached) {
    return [{
      type: 'close',
      reason: 'delta_stop',
      detail: `Stop por delta: ${breached.symbol} |Δ| ${Math.abs(breached.quote.delta).toFixed(2)}`,
      legs,
    }];
  }
  return [hold('in_position', `En posición: ${pnlPct.toFixed(1)} % de la prima`)];
}

function evaluate(ctx) {
  // `ctx.chain` se lee solo al entrar: en el backtest es perezosa y cara.
  const { now, spot, positions = [], params, lastOpenedAt } = ctx;
  if (positions.length) return manage(ctx);

  const window = entryWindow(now, params, lastOpenedAt);
  if (!window.open) return [skip('outside_window', window.detail)];
  const { chain } = ctx;
  if (!chain || !chain.rows?.length) return [skip('no_chain', 'Sin cadena para el vencimiento objetivo')];

  const iv = atmIv(chain, spot);
  if (iv == null) return [skip('no_iv', 'Sin IV ATM')];
  if (iv * 100 < params.minAtmIvPct) {
    return [skip('low_iv', `IV ATM ${(iv * 100).toFixed(1)} % < mínimo ${params.minAtmIvPct} %`)];
  }

  const call = pickLegByDelta(chain, 'C', params.targetDelta, spot, 'bid');
  const put = pickLegByDelta(chain, 'P', params.targetDelta, spot, 'bid');
  if (!call || !put) return [skip('no_legs', 'No hay call y put OTM con bid para la delta objetivo')];

  const opts = { side: 'SELL', quantity: params.quantity, expiry: chain.expiry };
  const legs = [
    legFromChain(call, { ...opts, type: 'C' }),
    legFromChain(put, { ...opts, type: 'P' }),
  ];
  return [{
    type: 'open',
    reason: 'entry',
    detail: `Vende strangle ${put.strike}P / ${call.strike}C (IV ATM ${(iv * 100).toFixed(1)} %)`,
    legs,
  }];
}

module.exports = {
  id,
  label: 'Short strangle',
  description: 'Vende una call y una put fuera del dinero y cobra la prima.',
  holdsSpot: false,
  defaultParams,
  paramSchema,
  evaluate,
};
