// Etiqueta compacta de un indicador para el legend overlay.
// Convierte type+params en algo como "EMA 20", "MACD 12/26/9", "BB 20/2".
export function formatIndicatorLabel(type, params, label) {
  const p = params || {};
  if (type === 'macd') return `${label} ${p.fast || 12}/${p.slow || 26}/${p.signal || 9}`;
  if (type === 'bollinger') return `${label} ${p.length || 20}/${p.stdDev || 2}`;
  if (type === 'keltner') return `${label} ${p.length || 20}/${p.atrLength || 10}`;
  if (type === 'stoch') return `${label} ${p.kLength || 14}/${p.dLength || 3}`;
  if (type === 'volume') return 'Vol';
  if (type === 'vwap') return 'VWAP';
  if (p.length != null) return `${label} ${p.length}`;
  return label;
}
