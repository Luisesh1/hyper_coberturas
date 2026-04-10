import { Interface } from 'ethers';

const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5412248n;
const RECIPIENT = '0x7614BC8DA965C231135684Fa6b851E932f680cCb';
// uint128 max: 0xffffffffffffffffffffffffffffffff = 340282366920938463463374607431768211455
const MAX_UINT128 = (1n << 128n) - 1n;

const ABI = [
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];

const iface = new Interface(ABI);
const calldata = iface.encodeFunctionData('collect', [{
  tokenId: TOKEN_ID,
  recipient: RECIPIENT,
  amount0Max: MAX_UINT128,
  amount1Max: MAX_UINT128,
}]);

console.log('=== Datos para llamar collect() en Uniswap V3 NonfungiblePositionManager ===');
console.log('');
console.log('Network:    Arbitrum One (chainId 42161)');
console.log('To:         ' + POSITION_MANAGER);
console.log('Value:      0 (cero ETH)');
console.log('Gas limit:  ~150000 (margen de sobra)');
console.log('');
console.log('Calldata (copiar TAL CUAL, incluyendo el 0x del inicio):');
console.log(calldata);
console.log('');
console.log('Argumentos decodificados:');
console.log('  tokenId      =', TOKEN_ID.toString());
console.log('  recipient    =', RECIPIENT);
console.log('  amount0Max   =', MAX_UINT128.toString(), '(uint128 max)');
console.log('  amount1Max   =', MAX_UINT128.toString(), '(uint128 max)');
console.log('');
console.log('Esto NO retira más de lo que hay: amountXMax es solo el techo. La');
console.log('cantidad real transferida será 0.019403230047244078 WETH +');
console.log('27.267042 USD₮0 — exactamente lo que está en tokensOwed.');
