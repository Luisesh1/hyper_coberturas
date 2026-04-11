const { ethers } = require('ethers');

const V4_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  SWEEP: 0x14,
};

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZERO_HOOKS_ADDRESS = ethers.ZeroAddress;
const DEFAULT_PERMIT2_EXPIRATION_SECONDS = 30 * 24 * 60 * 60;
const MAX_UINT160 = (1n << 160n) - 1n;

const UNIVERSAL_ROUTER_ADDRESSES = {
  ethereum: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
  arbitrum: '0xa51afafe0263b40eDAef0Df8781EA9Aa03E381A3',
};

const {
  V4_POSITION_MANAGER_ABI,
  V4_STATE_VIEW_ABI,
} = require('./uniswap/abis');

const PERMIT2_ABI = [
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

function normalizeOptionalAddress(value) {
  if (value == null || value === '') return null;
  return ethers.getAddress(String(value).trim());
}

function normalizeHooksAddress(value) {
  return normalizeOptionalAddress(value) || ZERO_HOOKS_ADDRESS;
}

function hasHooks(hooks) {
  return normalizeHooksAddress(hooks) !== ZERO_HOOKS_ADDRESS;
}

function getUniversalRouterAddress(network) {
  return UNIVERSAL_ROUTER_ADDRESSES[String(network || '').toLowerCase()] || null;
}

function computeV4PoolId(poolKey) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'],
    [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]]
  );
  return ethers.keccak256(encoded);
}

function encodeV4Plan(actions, params) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes', 'bytes[]'],
    [ethers.hexlify(Uint8Array.from(actions)), params]
  );
}

function encodeV4ModifyLiquidityParams({
  tokenId,
  liquidity,
  amount0Limit = 0n,
  amount1Limit = 0n,
  hookData = '0x',
}) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    [BigInt(tokenId), BigInt(liquidity), BigInt(amount0Limit), BigInt(amount1Limit), hookData]
  );
}

function encodeV4MintParams({
  poolKey,
  tickLower,
  tickUpper,
  liquidity,
  amount0Max,
  amount1Max,
  owner,
  hookData = '0x',
}) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
      'int24',
      'int24',
      'uint256',
      'uint128',
      'uint128',
      'address',
      'bytes',
    ],
    [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      Number(tickLower),
      Number(tickUpper),
      BigInt(liquidity),
      BigInt(amount0Max),
      BigInt(amount1Max),
      owner,
      hookData,
    ]
  );
}

function encodeV4CloseCurrencyParams(currency) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['address'], [currency]);
}

function encodeV4SwapExactInSingleParams({
  poolKey,
  zeroForOne,
  amountIn,
  amountOutMinimum,
  minHopPriceX36 = 0n,
  hookData = '0x',
}) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
    ],
    [[
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      Boolean(zeroForOne),
      BigInt(amountIn),
      BigInt(amountOutMinimum),
      BigInt(minHopPriceX36),
      hookData,
    ]]
  );
}

function encodeV4SettleAllParams(currency, maxAmount) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [currency, BigInt(maxAmount)]);
}

function encodeV4TakeAllParams(currency, minAmount) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [currency, BigInt(minAmount)]);
}

function buildV4ModifyLiquiditiesCalldata({ actions, params, deadline }) {
  const iface = new ethers.Interface(V4_POSITION_MANAGER_ABI);
  return iface.encodeFunctionData('modifyLiquidities', [encodeV4Plan(actions, params), BigInt(deadline)]);
}

function buildUniversalRouterCalldata({ actions, params, deadline }) {
  const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
  const commands = ethers.hexlify(Uint8Array.from([0x10]));
  const inputs = [encodeV4Plan(actions, params)];
  return iface.encodeFunctionData('execute', [commands, inputs, BigInt(deadline)]);
}

function buildPermit2ApproveCalldata(tokenAddress, spender, amount, expiration) {
  const iface = new ethers.Interface(PERMIT2_ABI);
  const approvedAmount = BigInt(amount) > MAX_UINT160 ? MAX_UINT160 : BigInt(amount);
  return iface.encodeFunctionData('approve', [tokenAddress, spender, approvedAmount, Number(expiration)]);
}

module.exports = {
  DEFAULT_PERMIT2_EXPIRATION_SECONDS,
  MAX_UINT160,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ABI,
  UNIVERSAL_ROUTER_ADDRESSES,
  V4_ACTIONS,
  V4_POSITION_MANAGER_ABI,
  V4_STATE_VIEW_ABI,
  ZERO_HOOKS_ADDRESS,
  buildPermit2ApproveCalldata,
  buildUniversalRouterCalldata,
  buildV4ModifyLiquiditiesCalldata,
  computeV4PoolId,
  encodeV4CloseCurrencyParams,
  encodeV4MintParams,
  encodeV4ModifyLiquidityParams,
  encodeV4SettleAllParams,
  encodeV4SwapExactInSingleParams,
  encodeV4TakeAllParams,
  getUniversalRouterAddress,
  hasHooks,
  normalizeHooksAddress,
};
