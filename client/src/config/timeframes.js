/**
 * Timeframes compartidos entre Strategy Studio, Bots, y Backtesting.
 */
export const TIMEFRAMES = [
  { value: '1m',  label: '1m' },
  { value: '5m',  label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1h' },
  { value: '4h',  label: '4h' },
  { value: '1d',  label: '1D' },
  { value: '1w',  label: '1W' },
];

/** Solo los values para uso rápido en validaciones */
export const TIMEFRAME_VALUES = TIMEFRAMES.map((tf) => tf.value);
