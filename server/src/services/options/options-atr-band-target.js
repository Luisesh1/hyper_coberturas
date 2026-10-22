'use strict';

/**
 * Objetivo de venta por banda ATR de un bot por alertas (`takeProfitMode =
 * 'atr_band'`). Se calcula UNA vez, segundos después del fill, y se persiste
 * en la posición (tp_target_price / tp_target_meta); nunca se recalcula.
 * Lo comparten el runner (sombra) y el ejecutor real (TP LIMIT GTC).
 *
 * Sin banda, tick o spot el objetivo queda pendiente (devuelve la posición
 * tal cual) y el llamador lo reintenta en su siguiente ciclo. Los errores
 * de mercado se propagan: el llamador decide si avisa o solo registra.
 */

const { parseSymbol } = require('./options-utils');
const { atrBandTakeProfit } = require('./options-atr-band-tp');

const hasTarget = (position) => Number(position?.tpTargetPrice) > 0;

/**
 * @param position  { id, symbol, entryPrice, tpTargetPrice? }
 * @param params    parámetros validados de alert_signal
 * @param deps      { market, repo, spot, tickSize?, minPrice?, now? }
 *                  `spot` del momento del fill (cadena/cotización del llamador).
 *                  Si no llega `tickSize`, se pide a market.getVolatilityInputs.
 * @returns la posición, con tpTargetPrice/tpTargetMeta si ya existe o se fijó.
 */
async function ensureAtrBandTarget(position, params, { market, repo, spot, tickSize, minPrice, now = Date.now() } = {}) {
  if (!position || params?.takeProfitMode !== 'atr_band' || hasTarget(position)) return position;
  const meta = parseSymbol(position.symbol);
  const s = Number(spot);
  if (!meta || !(s > 0)) return position;
  const interval = params.atrBandInterval;
  const length = params.atrBandLength;
  const multiplier = params.atrBandMultiplier;
  const band = await market.getAtrBand(meta.underlying, { interval, length, multiplier });
  if (!band) return position;
  let tick = Number(tickSize);
  let origin = minPrice;
  if (!(tick > 0)) {
    const inputs = await market.getVolatilityInputs(position.symbol);
    tick = Number(inputs?.tickSize);
    origin = inputs?.minPrice;
  }
  const tp = atrBandTakeProfit({
    fillPrice: position.entryPrice, spot: s, type: meta.type, band,
    tickSize: tick, minPrice: origin ?? 0, maxGainPct: params.tpMaxGainPct,
  });
  if (!tp) return position;
  const targetMeta = {
    spot: s, interval, length, multiplier,
    bandValue: tp.bandValue, distancePct: tp.distancePct, leverage: tp.leverage,
    rawGainPct: tp.rawGainPct, appliedGainPct: tp.appliedGainPct, capped: tp.capped,
    computedAt: now,
  };
  // El repositorio solo escribe si sigue vacío y devuelve la fila guardada:
  // si otro proceso se adelantó, gana su valor (nunca se recalcula).
  const saved = await repo.setTpTarget(position.id, tp.price, targetMeta);
  if (!hasTarget(saved)) return position;
  return { ...position, tpTargetPrice: Number(saved.tpTargetPrice), tpTargetMeta: saved.tpTargetMeta ?? null };
}

module.exports = { ensureAtrBandTarget };
