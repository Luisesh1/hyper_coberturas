/**
 * Plantillas de alertas comunes. Cada preset construye un payload listo
 * para enviar a `alertsApi.create` o para pre-poblar el editor.
 */

export const PRESETS = [
  {
    id: 'rsi_oversold',
    icon: '📉',
    title: 'RSI sobreventa',
    description: 'Avisa cuando el RSI(14) baja de 30 en el timeframe elegido. Patrón clásico de rebote.',
    build: ({ asset = 'BTCUSDT', timeframe = '15m' } = {}) => ({
      name: `${asset} · RSI sobreventa`,
      thresholdPercent: 100,
      cooldownSeconds: 900,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'rsi', indicatorParams: { length: 14 },
          timeframe, operandSeries: 'line',
          operator: '<', operand: { kind: 'constant', value: 30 },
        }],
        joiners: [],
      }],
    }),
  },
  {
    id: 'rsi_overbought',
    icon: '📈',
    title: 'RSI sobrecompra',
    description: 'Avisa cuando el RSI(14) supera 70. Útil para tomar profits.',
    build: ({ asset = 'BTCUSDT', timeframe = '15m' } = {}) => ({
      name: `${asset} · RSI sobrecompra`,
      thresholdPercent: 100,
      cooldownSeconds: 900,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'rsi', indicatorParams: { length: 14 },
          timeframe, operandSeries: 'line',
          operator: '>', operand: { kind: 'constant', value: 70 },
        }],
        joiners: [],
      }],
    }),
  },
  {
    id: 'macd_bull_cross',
    icon: '🟢',
    title: 'MACD cruce alcista',
    description: 'La línea MACD cruza por encima de su señal. Posible inicio de tendencia alcista.',
    build: ({ asset = 'BTCUSDT', timeframe = '15m' } = {}) => ({
      name: `${asset} · MACD ↑`,
      thresholdPercent: 100,
      cooldownSeconds: 1800,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'macd', indicatorParams: { fast: 12, slow: 26, signal: 9 },
          timeframe, operandSeries: 'macd',
          operator: 'cross_up',
          operand: { kind: 'series', indicatorType: 'macd', indicatorParams: { fast: 12, slow: 26, signal: 9 }, timeframe, operandSeries: 'signal' },
        }],
        joiners: [],
      }],
    }),
  },
  {
    id: 'golden_cross',
    icon: '🌟',
    title: 'Golden Cross (EMA 50 ↑ EMA 200)',
    description: 'EMA(50) cruza por encima de EMA(200) en 1h. Señal de largo plazo.',
    build: ({ asset = 'BTCUSDT' } = {}) => ({
      name: `${asset} · Golden Cross 1h`,
      thresholdPercent: 100,
      cooldownSeconds: 14400,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'ema', indicatorParams: { length: 50 },
          timeframe: '1h', operandSeries: 'line',
          operator: 'cross_up',
          operand: { kind: 'series', indicatorType: 'ema', indicatorParams: { length: 200 }, timeframe: '1h', operandSeries: 'line' },
        }],
        joiners: [],
      }],
    }),
  },
  {
    id: 'squeeze_release',
    icon: '💥',
    title: 'Squeeze release',
    description: 'El Squeeze Momentum acaba de soltarse: posible movimiento direccional.',
    build: ({ asset = 'BTCUSDT', timeframe = '15m' } = {}) => ({
      name: `${asset} · Squeeze release`,
      thresholdPercent: 100,
      cooldownSeconds: 1800,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'sqzmom', indicatorParams: { length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true },
          timeframe, operandSeries: 'sqzMomentum',
          operator: 'squeeze_off', operand: { kind: 'none' },
        }],
        joiners: [],
      }],
    }),
  },
  {
    id: 'rsi_zone',
    icon: '🎯',
    title: 'RSI en zona neutra (40–60)',
    description: 'RSI(14) entre 40 y 60. Útil para detectar rangos de acumulación.',
    build: ({ asset = 'BTCUSDT', timeframe = '15m' } = {}) => ({
      name: `${asset} · RSI 40-60`,
      thresholdPercent: 100,
      cooldownSeconds: 3600,
      telegramEnabled: true,
      datasource: 'binance',
      assetList: [asset],
      rules: [{
        weight: 1,
        conditions: [{
          indicatorType: 'rsi', indicatorParams: { length: 14 },
          timeframe, operandSeries: 'line',
          operator: 'between', operand: { kind: 'between', lower: 40, upper: 60 },
        }],
        joiners: [],
      }],
    }),
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
