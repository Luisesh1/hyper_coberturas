export const NETWORK_LABELS = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum One',
  base: 'Base',
  optimism: 'Optimism',
  polygon: 'Polygon',
  robinhood: 'Robinhood Chain',
  'base-sepolia': 'Base Sepolia',
};

export function networkLabelsFrom(analysis) {
  const fromAnalysis = Object.fromEntries((analysis?.balances?.networks || []).map((n) => [n.network, n.label]));
  return { ...NETWORK_LABELS, ...fromAnalysis };
}
