import { JsonRpcProvider, Contract, formatUnits } from 'ethers';

const RPC = process.env.UNI_RPC_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5412248n;
const WALLET = '0x7614BC8DA965C231135684Fa6b851E932f680cCb';

const ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function main() {
  const provider = new JsonRpcProvider(RPC, 42161, { staticNetwork: true });
  const pm = new Contract(POSITION_MANAGER, ABI, provider);

  console.log('=== Position 5412248 (Arbitrum Uniswap V3) ===\n');

  let owner;
  try {
    owner = await pm.ownerOf(TOKEN_ID);
    console.log('Owner on-chain:', owner);
    console.log('Expected wallet:', WALLET);
    console.log('Match:', owner.toLowerCase() === WALLET.toLowerCase() ? 'YES ✓' : 'NO ✗');
  } catch (err) {
    console.error('ownerOf failed (NFT may have been burned):', err.message);
    return;
  }

  let pos;
  try {
    pos = await pm.positions(TOKEN_ID);
  } catch (err) {
    console.error('positions() failed:', err.message);
    return;
  }

  console.log('\n--- Position state ---');
  console.log('token0:', pos.token0);
  console.log('token1:', pos.token1);
  console.log('fee tier:', Number(pos.fee), '(' + (Number(pos.fee)/10000).toFixed(4) + '%)');
  console.log('tickLower:', Number(pos.tickLower));
  console.log('tickUpper:', Number(pos.tickUpper));
  console.log('liquidity:', pos.liquidity.toString());
  console.log('tokensOwed0:', pos.tokensOwed0.toString());
  console.log('tokensOwed1:', pos.tokensOwed1.toString());

  const t0 = new Contract(pos.token0, ERC20_ABI, provider);
  const t1 = new Contract(pos.token1, ERC20_ABI, provider);
  const [sym0, dec0, sym1, dec1] = await Promise.all([
    t0.symbol(), t0.decimals(), t1.symbol(), t1.decimals(),
  ]);
  console.log('\n--- Tokens ---');
  console.log(`token0: ${sym0} (${Number(dec0)} decimals)`);
  console.log(`token1: ${sym1} (${Number(dec1)} decimals)`);

  console.log('\n--- Fees pendientes (sin retirar) ---');
  console.log(`tokensOwed0: ${formatUnits(pos.tokensOwed0, Number(dec0))} ${sym0}`);
  console.log(`tokensOwed1: ${formatUnits(pos.tokensOwed1, Number(dec1))} ${sym1}`);

  console.log('\n--- Conclusión ---');
  if (pos.liquidity > 0n) {
    console.log('⚠ La posición TIENE liquidez activa:', pos.liquidity.toString());
    console.log('  → Los fondos siguen depositados en la pool, no se perdieron.');
    console.log('  → El owner (' + owner + ') puede retirarlos.');
  } else if (pos.tokensOwed0 > 0n || pos.tokensOwed1 > 0n) {
    console.log('La liquidez es 0 pero hay fees por cobrar.');
  } else {
    console.log('La liquidez es 0 y no hay fees pendientes.');
  }
}

main().catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
