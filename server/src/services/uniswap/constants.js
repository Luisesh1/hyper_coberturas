/**
 * Constantes globales para acciones sobre posiciones de Uniswap.
 * Extraído de `uniswap-position-actions.service.js`.
 */

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_DEADLINE_SECONDS = 1800;
const DEFAULT_SLIPPAGE_BPS = 100;
// SwapRouter02 de las redes donde comparte direccion (Ethereum, Arbitrum,
// Optimism, Polygon). Cada red la declara en networks.js.
const V3_SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
// Sin fallback a propósito: en Base esa dirección es otro contrato cuyo
// fallback acepta la llamada sin hacer nada, así que el "swap" se minaba en
// verde sin mover un token. Una red sin router declarado tiene que fallar.
const getV3SwapRouterAddress = (networkConfig) => {
  const router = networkConfig?.deployments?.v3?.swapRouter;
  if (!router) {
    throw new Error(`La red ${networkConfig?.id || 'desconocida'} no declara deployments.v3.swapRouter`);
  }
  return router;
};
const CLOSE_SWAP_BUFFER_BPS = 9800n;

const ACTIONS = new Set([
  'increase-liquidity',
  'decrease-liquidity',
  'collect-fees',
  'reinvest-fees',
  'modify-range',
  'rebalance',
  'create-position',
  'close-to-usdc',
  'close-keep-assets',
]);

const CLOSE_ACTIONS = new Set([
  'close-to-usdc',
  'close-keep-assets',
]);

module.exports = {
  MAX_UINT128,
  MAX_UINT256,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  V3_SWAP_ROUTER_ADDRESS,
  getV3SwapRouterAddress,
  CLOSE_SWAP_BUFFER_BPS,
  ACTIONS,
  CLOSE_ACTIONS,
};
