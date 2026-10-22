/**
 * Bot por alertas: abre una pata cuando llega una señal alcista o bajista y
 * la gestiona con toma de ganancia, stop y salida por tiempo.
 *
 * - `buy_with` (comprar a favor): alcista → compra call, bajista → compra put.
 * - `sell_against` (vender en contra): alcista → vende put, bajista → vende call.
 *
 * `evaluate(ctx)` es pura. Sin `ctx.signal` solo evalúa salidas (tick del
 * runner). Con señal: (1) posición contraria según `onOpposite`, (2) límites
 * de posiciones abiertas y operaciones del día, (3) apertura por delta en el
 * vencimiento más cercano a `expiryDays` (la cadena la elige el runner).
 *
 * `takeProfitMode = 'atr_band'` (solo `buy_with`): el precio de venta se fija
 * una vez al llenarse (banda ATR, ver options-atr-band-target) y queda como
 * LIMIT GTC en Binance. No hay otras salidas: ni stop, ni por tiempo, ni por
 * señal contraria; si no se vende, se mantiene hasta la liquidación.
 */

const { ValidationError } = require('../../../errors/app-error');
const {
  FIELDS, hold, skip, legFromChain, closeLegs, closeValue, hoursToExpiry,
  validateParams: validateNumericParams,
} = require('./helpers');

const id = 'alert_signal';

const STRUCTURES = ['buy_with', 'sell_against'];
const ON_OPPOSITE = ['reverse', 'close', 'ignore'];
const TAKE_PROFIT_MODES = ['fixed', 'volatility', 'atr_band'];
const ATR_BAND_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
const DIRECTIONS = ['bullish', 'bearish'];
const DIRECTION_LABEL = { bullish: 'alcista', bearish: 'bajista', neutral: 'neutral' };

const STRUCTURE_DEFAULTS = {
  buy_with: { targetDelta: 0.35, takeProfitPct: 80, stopLossPct: 50 },
  sell_against: { targetDelta: 0.25, takeProfitPct: 50, stopLossPct: 200 },
};

const defaultParams = {
  alertIds: [],
  structure: 'buy_with',
  ...STRUCTURE_DEFAULTS.buy_with,
  expiryDays: 7,
  quantity: 0.01,
  onOpposite: 'reverse',
  exitHoursBeforeExpiry: 12,
  maxOpenPositions: 1,
  maxTradesPerDay: 4,
  maxPremiumUsdt: null,
  contractCount: 1,
  capitalUsdt: null,
  takeProfitMode: 'fixed',
  tpAtrMultiplier: 1,
  tpHorizonHours: 4,
  atrBandInterval: '1h',
  atrBandLength: 14,
  atrBandMultiplier: 2,
  tpMaxGainPct: 200,
};

const NUMERIC_FIELDS = [
  { ...FIELDS.targetDelta, max: 0.95 },
  FIELDS.expiryDays,
  { ...FIELDS.quantity, label: 'Cantidad' },
  { ...FIELDS.takeProfitPct, max: 1000 },
  { key: 'stopLossPct', label: 'Stop por pérdida', type: 'number', min: 1, max: 1000, step: 5, unit: '% de la prima' },
  FIELDS.exitHoursBeforeExpiry,
  { key: 'maxOpenPositions', label: 'Máximo de posiciones abiertas', type: 'number', integer: true, min: 1, max: 20, step: 1 },
  { key: 'maxTradesPerDay', label: 'Máximo de operaciones por día', type: 'number', integer: true, min: 1, max: 100, step: 1 },
  { key: 'maxPremiumUsdt', label: 'Prima máxima por operación', type: 'number', min: 0, max: 1e7, step: 1, unit: 'USDT', nullable: true },
  { key: 'tpAtrMultiplier', label: 'Multiplicador ATR del TP', type: 'number', min: 0.25, max: 4, step: 0.25 },
  { key: 'tpHorizonHours', label: 'Horizonte TP por volatilidad', type: 'number', min: 1, max: 24, step: 1, integer: true, unit: 'horas' },
  { key: 'atrBandLength', label: 'Longitud de la banda ATR', type: 'number', integer: true, min: 2, max: 100, step: 1, unit: 'velas' },
  { key: 'atrBandMultiplier', label: 'Multiplicador de la banda ATR', type: 'number', min: 0.25, max: 10, step: 0.25 },
  { key: 'tpMaxGainPct', label: 'Tope de ganancia del TP', type: 'number', min: 10, max: 2000, step: 10, unit: '% de la prima' },
];

const paramSchema = [
  { key: 'contractCount', label: 'Contratos distintos', type: 'number', integer: true, min: 1, max: 10, step: 1 },
  { key: 'capitalUsdt', label: 'Capital máximo de entrada', type: 'number', min: 0.01, max: 1e7, nullable: true, unit: 'USDT' },
  { key: 'alertIds', label: 'Alertas', type: 'alerts' },
  { key: 'takeProfitMode', label: 'Tipo de Take Profit', type: 'enum', options: TAKE_PROFIT_MODES },
  { key: 'atrBandInterval', label: 'Temporalidad de la banda ATR', type: 'enum', options: ATR_BAND_INTERVALS },
  { key: 'structure', label: 'Estructura', type: 'enum', options: STRUCTURES },
  { key: 'onOpposite', label: 'Señal contraria', type: 'enum', options: ON_OPPOSITE },
  ...NUMERIC_FIELDS,
];

function normalizeAlertIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Alertas: debe ser una lista de ids');
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new ValidationError('Alertas: ids inválidos');
  return [...new Set(ids)];
}

function pickEnum(value, options, fallback, label) {
  const v = value === undefined || value === null || value === '' ? fallback : value;
  if (!options.includes(v)) throw new ValidationError(`${label}: debe ser ${options.join(' | ')}`);
  return v;
}

/**
 * Valida y completa los parámetros. Los valores por defecto de delta y
 * salidas dependen de la estructura (comprar o vender).
 */
function validateParams(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const structure = pickEnum(input.structure, STRUCTURES, defaultParams.structure, 'Estructura');
  let onOpposite = pickEnum(input.onOpposite, ON_OPPOSITE, defaultParams.onOpposite, 'Señal contraria');
  const takeProfitMode = pickEnum(input.takeProfitMode, TAKE_PROFIT_MODES, defaultParams.takeProfitMode, 'Tipo de Take Profit');
  const atrBandInterval = pickEnum(input.atrBandInterval, ATR_BAND_INTERVALS, defaultParams.atrBandInterval, 'Temporalidad de la banda ATR');
  if (takeProfitMode === 'atr_band' && structure !== 'buy_with') {
    throw new ValidationError('Tipo de Take Profit: la banda ATR solo existe con «Comprar a favor»');
  }
  const numeric = validateNumericParams(
    { paramSchema: NUMERIC_FIELDS, defaultParams: { ...defaultParams, ...STRUCTURE_DEFAULTS[structure] } },
    input
  );
  // La prima máxima solo aplica al comprar.
  if (structure !== 'buy_with') numeric.maxPremiumUsdt = null;
  // Banda ATR: la única salida es el objetivo (o el vencimiento). La señal
  // contraria se ignora y no hay salida por tiempo; el plazo de la LIMIT en
  // Binance queda en vencimiento − 1 h (Math.max(1, 0) del ejecutor).
  if (takeProfitMode === 'atr_band') {
    onOpposite = 'ignore';
    numeric.exitHoursBeforeExpiry = 0;
  }
  const contractCount = input.contractCount == null ? 1 : Number(input.contractCount);
  const capitalUsdt = input.capitalUsdt == null || input.capitalUsdt === '' ? null : Number(input.capitalUsdt);
  if (!Number.isInteger(contractCount) || contractCount < 1 || contractCount > 10) throw new ValidationError('contractCount debe estar entre 1 y 10');
  if (capitalUsdt !== null && (!Number.isFinite(capitalUsdt) || capitalUsdt <= 0 || capitalUsdt > 1e7)) throw new ValidationError('capitalUsdt inválido');
  return { alertIds: normalizeAlertIds(input.alertIds), structure, onOpposite, takeProfitMode, atrBandInterval, ...numeric, contractCount, capitalUsdt };
}

/** Pata que abre una señal según la estructura. */
function legFor(structure, direction) {
  if (structure === 'buy_with') return { side: 'BUY', type: direction === 'bullish' ? 'C' : 'P' };
  return { side: 'SELL', type: direction === 'bullish' ? 'P' : 'C' };
}

/** Dirección de una posición: compra de call o venta de put apuestan al alza. */
function positionDirection(position) {
  const bullish = (position.side === 'BUY' && position.type === 'C') || (position.side === 'SELL' && position.type === 'P');
  return bullish ? 'bullish' : 'bearish';
}

function describeLeg({ side, type }, strike) {
  return `${side === 'BUY' ? 'compra' : 'vende'} ${strike ?? ''}${type}`.trim();
}

/** P&L de una pata en % de la prima de entrada (positivo = ganancia). */
function pnlPct(position) {
  // Nunca activar una salida de un bot real por mark/Black-Scholes cuando
  // Binance no ofrece un bid/ask ejecutable. El fallback teórico en
  // closeValue es útil para shadow, pero NO para disparar stops/TP reales.
  const executable = position?.quote?.[position.side === 'BUY' ? 'bid' : 'ask'];
  if (executable == null || !Number.isFinite(Number(executable)) ||
      Number(executable) <= 0) return null;
  const value = closeValue(position);
  if (value == null) return null;
  const premium = position.entryPrice * position.quantity;
  if (!(premium > 0)) return 0;
  const diff = position.side === 'BUY' ? value - premium : premium - value;
  return (diff / premium) * 100;
}

/**
 * Banda ATR: emula la LIMIT en reposo. Cierra solo cuando el precio
 * ejecutable (bid al vender lo comprado) alcanza el objetivo fijado al
 * llenarse. Ninguna otra salida; el vencimiento lo liquida el runner.
 */
function atrBandExits(positions) {
  const actions = [];
  let pending = false;
  for (const p of positions) {
    const target = Number(p.tpTargetPrice);
    if (!(target > 0)) {
      pending = true;
      continue;
    }
    const executable = Number(p.quote?.[p.side === 'BUY' ? 'bid' : 'ask']);
    const reached = Number.isFinite(executable) && executable > 0 &&
      (p.side === 'BUY' ? executable >= target : executable <= target);
    if (reached) {
      actions.push({ type: 'close', reason: 'take_profit_atr_band',
        detail: `TP banda ATR en ${p.symbol}: objetivo ${target} USDT, cotización ${executable} USDT`,
        legs: closeLegs([p]).map((l) => ({ ...l, targetPrice: target })) });
    }
  }
  if (actions.length) return actions;
  if (!positions.length) return [hold('waiting_signal', 'Esperando señal')];
  if (pending) return [hold('atr_band_tp_pending', 'Objetivo por banda ATR pendiente: faltan velas, tick o spot de Binance')];
  return [hold('in_position', `En posición: ${positions.length} pata(s) abierta(s), objetivo fijo por banda ATR`)];
}

/** Salidas por tiempo, toma de ganancia y stop, una por posición. */
function exits(ctx) {
  const { now, positions = [], params } = ctx;
  if (params.takeProfitMode === 'atr_band') return atrBandExits(positions);
  const actions = [];
  let missingQuote = false;
  let missingVolatility = false;
  for (const p of positions) {
    const legs = closeLegs([p]);
    const hours = hoursToExpiry(p, now);
    if (params.exitHoursBeforeExpiry > 0 && hours <= params.exitHoursBeforeExpiry) {
      actions.push({ type: 'close', reason: 'time_exit', detail: `Salida por tiempo: quedan ${hours.toFixed(1)} h al vencimiento de ${p.symbol}`, legs });
      continue;
    }
    const pct = pnlPct(p);
    if (pct == null) {
      missingQuote = true;
      continue;
    }
    // El objetivo se calcula sobre el precio de fill confirmado, pero la
    // condición se comprueba con el bid (para vender) o ask (para recomprar).
    // No activar TP por mark/Black-Scholes sin liquidez ejecutable.
    const dynamic = params.takeProfitMode === 'volatility';
    const target = Number(p.takeProfitTarget?.price);
    const executable = Number(p.quote?.[p.side === 'BUY' ? 'bid' : 'ask']);
    const targetReached = dynamic && Number.isFinite(target) && target > 0 &&
      Number.isFinite(executable) && executable > 0 &&
      (p.side === 'BUY' ? executable >= target : executable <= target);
    if (targetReached) {
      actions.push({ type: 'close', reason: 'take_profit_volatility',
        detail: `TP ATR/IV en ${p.symbol}: objetivo ${target} USDT, cotización ${executable} USDT`,
        legs: legs.map((l) => ({ ...l, targetPrice: target })) });
    } else if (!dynamic && pct >= params.takeProfitPct) {
      actions.push({ type: 'close', reason: 'take_profit', detail: `Take profit en ${p.symbol}: ${pct.toFixed(1)} % de la prima`, legs });
    } else if (-pct >= params.stopLossPct) {
      actions.push({ type: 'close', reason: 'stop_loss', detail: `Stop en ${p.symbol}: pérdida del ${(-pct).toFixed(1)} % de la prima`, legs });
    } else if (dynamic && !(target > 0)) {
      missingVolatility = true;
    }
  }
  if (actions.length) return actions;
  if (!positions.length) return [hold('waiting_signal', 'Esperando señal')];
  if (missingQuote) return [hold('no_quote', 'Sin cotización para valorar la posición')];
  if (missingVolatility) return [hold('no_volatility_tp', 'TP por volatilidad pendiente: faltan IV, ATR o tick de Binance')];
  return [hold('in_position', `En posición: ${positions.length} pata(s) abierta(s)`)];
}

function openFor(ctx, direction, openCount) {
  const { spot, params, tradesToday = 0 } = ctx;
  if (openCount + (params.contractCount || 1) > params.maxOpenPositions) {
    return skip('max_open_positions', `Máximo de ${params.maxOpenPositions} posición(es) abierta(s) alcanzado`);
  }
  if (tradesToday >= params.maxTradesPerDay) {
    return skip('max_trades_per_day', `Máximo de ${params.maxTradesPerDay} operación(es) por día alcanzado`);
  }
  const { chain } = ctx;
  if (!chain || !chain.rows?.length) return skip('no_chain', 'Sin cadena para el vencimiento objetivo');
  if (!(Number(spot) > 0)) return skip('no_spot', 'Sin precio spot: no se puede elegir strike ni dimensionar');
  const leg = legFor(params.structure, direction);
  const candidates = chain.rows.map((row) => ({ row, quote: leg.type === 'C' ? row.call : row.put }))
    .filter(({ row, quote }) => quote && Number.isFinite(Number(quote.delta))
      && Number(leg.type === 'C' ? row.strike : -row.strike) > (leg.type === 'C' ? spot : -spot)
      && Number(quote[leg.side === 'BUY' ? 'ask' : 'bid']) > 0)
    .sort((a, b) => Math.abs(Math.abs(Number(a.quote.delta)) - params.targetDelta)
      - Math.abs(Math.abs(Number(b.quote.delta)) - params.targetDelta));
  const count = params.contractCount || 1;
  const selected = candidates.slice(0, count);
  if (selected.length < count) return skip('no_legs', 'No hay suficientes contratos líquidos para la selección');
  // Presupuesto repartido por igual. Para ventas es margen estimado, no la prima.
  // Se redondea siempre hacia abajo; nunca se excede la cantidad configurada.
  const budget = params.capitalUsdt;
  const legs = selected.map(({ row, quote }) => {
    const price = Number(quote[leg.side === 'BUY' ? 'ask' : 'bid']);
    const otm = leg.type === 'C' ? Math.max(row.strike - spot, 0) : Math.max(spot - row.strike, 0);
    const unitCapital = leg.side === 'BUY' ? price : price + Math.max(0.15 * spot - otm, 0.1 * spot);
    const step = Number(quote.stepSize) > 0 ? Number(quote.stepSize) : 0.0001;
    const minimum = Number(quote.minQty) > 0 ? Number(quote.minQty) : step;
    const maximum = Number(quote.maxQty) > 0 ? Number(quote.maxQty) : params.quantity;
    const allowedQty = Math.min(params.quantity, maximum,
      budget == null ? params.quantity : budget / count / unitCapital);
    // Binance valida (qty-minQty) % stepSize == 0. Siempre redondear
    // hacia ABAJO para mantener cantidad/capital dentro del límite.
    const steps = Math.floor((allowedQty - minimum + 1e-12) / step);
    const quantity = steps >= 0 ? Number((minimum + steps * step).toFixed(12)) : null;
    return quantity != null && quantity >= minimum ? legFromChain({ leg: quote, strike: row.strike }, {
      side: leg.side, quantity, type: leg.type, expiry: chain.expiry,
    }) : null;
  });
  if (legs.some((item) => !item)) return skip('capital_limit', 'Capital insuficiente para todos los contratos');
  const premium = legs.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (leg.side === 'BUY' && params.maxPremiumUsdt != null && premium > params.maxPremiumUsdt) {
    return skip('max_premium', 'La prima supera el máximo configurado');
  }
  const description = legs.length === 1 ? describeLeg(leg, selected[0].row.strike) : `${legs.length} contratos`;
  return { type: 'open', reason: 'signal', detail: `Señal ${DIRECTION_LABEL[direction]}: ${description} (vence ${chain.expiry})`, legs };

}

function evaluate(ctx) {
  const { positions = [], params, signal } = ctx;
  if (!signal) return exits(ctx);

  const direction = signal.direction;
  if (!DIRECTIONS.includes(direction)) return [skip('neutral', 'Alerta neutral')];

  // 1. Posición contraria.
  const opposite = positions.filter((p) => positionDirection(p) !== direction);
  const actions = [];
  let openCount = positions.length;
  if (opposite.length) {
    if (params.onOpposite === 'ignore') {
      return [skip('opposite_ignored', `Señal ${DIRECTION_LABEL[direction]} ignorada: hay posición en sentido contrario`)];
    }
    actions.push({
      type: 'close',
      reason: 'opposite_signal',
      detail: `Señal ${DIRECTION_LABEL[direction]}: cierra la posición contraria`,
      legs: closeLegs(opposite),
    });
    openCount -= opposite.length;
    if (params.onOpposite === 'close') return actions;
  }

  // 2 y 3. Límites y apertura.
  actions.push(openFor(ctx, direction, openCount));
  return actions;
}

module.exports = {
  id,
  label: 'Bot por alertas',
  description: 'Abre opciones cuando se disparan alertas alcistas o bajistas.',
  holdsSpot: false,
  // Se maneja desde /options/auto-bots: no se lista en las plantillas de Estrategias ni se backtestea.
  signalDriven: true,
  defaultParams,
  paramSchema,
  validateParams,
  evaluate,
  STRUCTURES,
  ON_OPPOSITE,
  STRUCTURE_DEFAULTS,
  TAKE_PROFIT_MODES,
  ATR_BAND_INTERVALS,
  legFor,
  positionDirection,
};
