/**
 * Constantes globales para acciones sobre posiciones de Uniswap.
 * Extraído de `uniswap-position-actions.service.js`.
 */

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_DEADLINE_SECONDS = 1800;
const DEFAULT_SLIPPAGE_BPS = 100;
const V3_SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
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
  CLOSE_SWAP_BUFFER_BPS,
  ACTIONS,
  CLOSE_ACTIONS,
};
