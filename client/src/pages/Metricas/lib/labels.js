/** Etiquetas legibles de redes, fuentes y antiguedad para Metricas. */

export const NETWORK_LABELS = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base: 'Base',
  optimism: 'Optimism',
  polygon: 'Polygon',
  robinhood: 'Robinhood',
};

export function networkLabel(id) {
  return NETWORK_LABELS[id] || id;
}

export function shortAddress(address) {
  if (!address || address.length < 12) return address || '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** `tokens:polygon` → "Tokens en Polygon"; `lp:v3:arbitrum:12` → "LP #12 (Arbitrum)". */
export function sourceLabel(key) {
  if (key === 'hl') return 'Hyperliquid';
  const [kind, ...rest] = String(key).split(':');
  if (kind === 'tokens') return `Tokens en ${networkLabel(rest[0])}`;
  if (kind === 'lps') return `LPs en ${networkLabel(rest[0])}`;
  if (kind === 'lp') return `LP #${rest[2]} (${networkLabel(rest[1])})`;
  return key;
}

export function ageLabel(ms, now = Date.now()) {
  if (ms == null) return 'nunca ha respondido';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 60) return `dato de hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `dato de hace ${hours} h`;
  return `dato de hace ${Math.round(hours / 24)} d`;
}
