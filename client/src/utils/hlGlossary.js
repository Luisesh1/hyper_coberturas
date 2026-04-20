/**
 * hlGlossary.js
 *
 * Traducción a texto humano de los acrónimos de Hyperliquid / DeFi que
 * aparecen en la UI. Evita que el usuario vea "oid" o "szi" sin contexto.
 *
 * Uso típico:
 *   <label>{HL_LABELS.oid} <abbr title={HL_GLOSSARY.oid}>(oid)</abbr></label>
 *   o:
 *   <span title={humanize('szi')}>{labelFor('szi')}</span>
 */

export const HL_LABELS = {
  oid: 'ID de orden',
  cloid: 'ID de cliente',
  szi: 'Tamaño de posición',
  sz: 'Tamaño',
  origSz: 'Tamaño original',
  ntli: 'Notional (USD)',
  imr: 'Margen requerido',
  mmr: 'Margen de mantenimiento',
  tpsl: 'Take-profit / Stop-loss',
  tif: 'Vigencia de la orden',
  gtc: 'GTC — vigente hasta cancelar',
  ioc: 'IOC — llenar o cancelar',
  alo: 'ALO — solo maker',
  slippage: 'Deslizamiento',
  avgPx: 'Precio promedio',
  entryPx: 'Precio de entrada',
  markPx: 'Precio de marca',
  midPx: 'Precio medio',
  unrealizedPnl: 'PnL no realizado',
  realizedPnl: 'PnL realizado',
  funding: 'Funding rate',
  leverage: 'Apalancamiento',
  cross: 'Cross margin (compartido)',
  isolated: 'Isolated margin (aislado)',
  liquidationPx: 'Precio de liquidación',
  reduceOnly: 'Solo reduce posición',
};

export const HL_GLOSSARY = {
  oid: 'Identificador único de una orden en Hyperliquid.',
  cloid: 'ID asignado por el cliente (32 bytes hex). Permite detectar duplicados si un request se reintenta.',
  szi: 'Tamaño con signo: positivo = LONG, negativo = SHORT.',
  ntli: 'Valor nocional de la posición en USD (ntl inicial = size × precio).',
  imr: 'Margen inicial requerido para abrir la posición, en USD.',
  mmr: 'Margen mínimo que debes mantener para evitar liquidación.',
  tif: 'Time in Force: GTC (hasta cancelar), IOC (llenar o cancelar), ALO (añadir liquidez, solo maker).',
  funding: 'Pago periódico entre longs y shorts en perpetuos. Negativo significa que pagaste; positivo que cobraste.',
  slippage: 'Diferencia entre el precio esperado y el precio efectivo al ejecutar la orden.',
  cross: 'El colateral de toda la cuenta respalda todas las posiciones. Mayor capital de uso pero mayor riesgo de liquidación en cascada.',
  isolated: 'Cada posición tiene su propio colateral. Si se liquida solo pierdes ese margen, no el resto de la cuenta.',
  reduceOnly: 'La orden solo puede cerrar la posición existente, nunca abrirla en el lado opuesto.',
};

/**
 * Devuelve el label humano; si no hay mapeo, devuelve la clave original.
 */
export function labelFor(key) {
  return HL_LABELS[key] || key;
}

/**
 * Devuelve la explicación larga (para tooltips). '' si no hay.
 */
export function humanize(key) {
  return HL_GLOSSARY[key] || '';
}
