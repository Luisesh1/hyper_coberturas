/**
 * Plantillas de estrategia pre-construidas.
 * Cada template incluye código funcional listo para guardar y ejecutar.
 */

export const STRATEGY_TEMPLATES = [
  {
    key: 'ma_crossover',
    name: 'Cruce de Medias Moviles',
    description: 'Abre long cuando la media rapida cruza sobre la lenta, short al reves. Cierra por inversion.',
    timeframe: '15m',
    defaultParams: { indicator: 'ema', fastPeriod: 9, slowPeriod: 21 },
    scriptSource: `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 200 });
  const ind = ctx.params.indicator === 'sma' ? 'sma' : 'ema';
  const fast = ctx.indicators[ind](candles, { period: ctx.params.fastPeriod || 9 });
  const slow = ctx.indicators[ind](candles, { period: ctx.params.slowPeriod || 21 });
  const fastLast = ctx.indicators.last(fast);
  const slowLast = ctx.indicators.last(slow);
  const position = ctx.account.position();

  if (fastLast == null || slowLast == null) return signal.hold();
  if (!position && fastLast > slowLast) return signal.long();
  if (!position && fastLast < slowLast) return signal.short();
  if (position?.side === 'long' && fastLast < slowLast) return signal.close();
  if (position?.side === 'short' && fastLast > slowLast) return signal.close();
  return signal.hold();
};`,
  },
  {
    key: 'rsi_extremes',
    name: 'RSI Sobrecompra/Sobreventa',
    description: 'Abre long en sobreventa (RSI < 30), short en sobrecompra (RSI > 70). Cierra al volver a zona neutral.',
    timeframe: '15m',
    defaultParams: { period: 14, oversold: 30, overbought: 70, neutralLow: 45, neutralHigh: 55 },
    scriptSource: `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 100 });
  const rsiValues = ctx.indicators.rsi(candles, { period: ctx.params.period || 14 });
  const rsi = ctx.indicators.last(rsiValues);
  const position = ctx.account.position();

  if (rsi == null) return signal.hold();

  const oversold = ctx.params.oversold || 30;
  const overbought = ctx.params.overbought || 70;
  const neutralLow = ctx.params.neutralLow || 45;
  const neutralHigh = ctx.params.neutralHigh || 55;

  if (!position && rsi < oversold) return signal.long({ meta: { setup: 'oversold', rsi } });
  if (!position && rsi > overbought) return signal.short({ meta: { setup: 'overbought', rsi } });
  if (position?.side === 'long' && rsi > neutralHigh) return signal.close();
  if (position?.side === 'short' && rsi < neutralLow) return signal.close();
  return signal.hold();
};`,
  },
  {
    key: 'bollinger_breakout',
    name: 'Bollinger Bands Breakout',
    description: 'Abre long al romper la banda superior, short al romper la inferior. Cierra al tocar la media.',
    timeframe: '1h',
    defaultParams: { period: 20, multiplier: 2 },
    scriptSource: `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 100 });
  const bb = ctx.indicators.bollinger(candles, {
    period: ctx.params.period || 20,
    multiplier: ctx.params.multiplier || 2,
  });
  const last = ctx.indicators.last(bb);
  const price = ctx.market.lastPrice();
  const position = ctx.account.position();

  if (!last || !price) return signal.hold();

  if (!position && price > last.upper) return signal.long({ meta: { setup: 'upper_break' } });
  if (!position && price < last.lower) return signal.short({ meta: { setup: 'lower_break' } });
  if (position?.side === 'long' && price <= last.middle) return signal.close();
  if (position?.side === 'short' && price >= last.middle) return signal.close();
  return signal.hold();
};`,
  },
  {
    key: 'macd_signal',
    name: 'MACD Signal Cross',
    description: 'Abre long cuando MACD cruza sobre la linea signal, short cuando cruza por debajo.',
    timeframe: '15m',
    defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    scriptSource: `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 200 });
  const macdValues = ctx.indicators.macd(candles, {
    fastPeriod: ctx.params.fastPeriod || 12,
    slowPeriod: ctx.params.slowPeriod || 26,
    signalPeriod: ctx.params.signalPeriod || 9,
  });

  if (macdValues.length < 2) return signal.hold();
  const curr = macdValues[macdValues.length - 1];
  const prev = macdValues[macdValues.length - 2];
  if (!curr || !prev || curr.macd == null || prev.macd == null) return signal.hold();

  const position = ctx.account.position();
  const bullishCross = prev.macd <= prev.signal && curr.macd > curr.signal;
  const bearishCross = prev.macd >= prev.signal && curr.macd < curr.signal;

  if (!position && bullishCross) return signal.long({ meta: { setup: 'macd_bull_cross' } });
  if (!position && bearishCross) return signal.short({ meta: { setup: 'macd_bear_cross' } });
  if (position?.side === 'long' && bearishCross) return signal.close();
  if (position?.side === 'short' && bullishCross) return signal.close();
  return signal.hold();
};`,
  },
  {
    key: 'mean_reversion',
    name: 'Mean Reversion (EMA + ATR)',
    description: 'Abre posicion cuando el precio se aleja N ATRs de la EMA. Cierra al regresar a la media.',
    timeframe: '1h',
    defaultParams: { emaPeriod: 50, atrPeriod: 14, atrMultiplier: 2 },
    scriptSource: `module.exports.evaluate = async function evaluate(ctx) {
  const candles = ctx.market.candles({ limit: 200 });
  const ema = ctx.indicators.ema(candles, { period: ctx.params.emaPeriod || 50 });
  const atr = ctx.indicators.atr(candles, { period: ctx.params.atrPeriod || 14 });
  const emaLast = ctx.indicators.last(ema);
  const atrLast = ctx.indicators.last(atr);
  const price = ctx.market.lastPrice();
  const position = ctx.account.position();

  if (!emaLast || !atrLast || !price) return signal.hold();

  const mult = ctx.params.atrMultiplier || 2;
  const deviation = (price - emaLast) / atrLast;

  // Precio muy por debajo de la media → long (esperando regresion)
  if (!position && deviation < -mult) return signal.long({ meta: { setup: 'oversold', deviation } });
  // Precio muy por encima → short
  if (!position && deviation > mult) return signal.short({ meta: { setup: 'overbought', deviation } });
  // Cerrar cuando regrese a la media
  if (position?.side === 'long' && price >= emaLast) return signal.close();
  if (position?.side === 'short' && price <= emaLast) return signal.close();
  return signal.hold();
};`,
  },
];
