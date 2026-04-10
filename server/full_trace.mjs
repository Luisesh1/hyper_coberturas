import { JsonRpcProvider, Contract, formatUnits } from 'ethers';

// Tres RPC distintos para verificar contra varias fuentes
const RPCS = [
  { name: 'PublicNode', url: 'https://arbitrum-one-rpc.publicnode.com' },
  { name: 'Arbitrum.io', url: 'https://arb1.arbitrum.io/rpc' },
  { name: 'LlamaRPC', url: 'https://arbitrum.llamarpc.com' },
];

const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5412248n;
const WALLET = '0x7614BC8DA965C231135684Fa6b851E932f680cCb';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDT0 = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';

const PM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function traceVia(rpc) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`RPC: ${rpc.name} (${rpc.url})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const provider = new JsonRpcProvider(rpc.url, 42161, { staticNetwork: true });
  const pm = new Contract(POSITION_MANAGER, PM_ABI, provider);

  // 1. Owner del NFT 5412248
  let owner;
  try {
    owner = await pm.ownerOf(TOKEN_ID);
  } catch (err) {
    console.log(`✗ ownerOf falló: ${err.message?.slice(0, 80)}`);
    return null;
  }
  console.log(`Owner del NFT 5412248:        ${owner}`);
  console.log(`Wallet declarada por usuario: ${WALLET}`);
  console.log(`Match:                        ${owner.toLowerCase() === WALLET.toLowerCase() ? '✓ SÍ' : '✗ NO'}`);

  // 2. Estado de la posición
  const pos = await pm.positions(TOKEN_ID);
  console.log(`\n--- positions(${TOKEN_ID}) ---`);
  console.log(`token0:       ${pos.token0}  ${pos.token0.toLowerCase() === WETH.toLowerCase() ? '✓ WETH' : '✗'}`);
  console.log(`token1:       ${pos.token1}  ${pos.token1.toLowerCase() === USDT0.toLowerCase() ? '✓ USD₮0' : '✗'}`);
  console.log(`fee tier:     ${Number(pos.fee)}`);
  console.log(`tick range:   [${Number(pos.tickLower)}, ${Number(pos.tickUpper)}]`);
  console.log(`liquidity:    ${pos.liquidity.toString()}`);
  console.log(`tokensOwed0:  ${pos.tokensOwed0.toString()}        = ${formatUnits(pos.tokensOwed0, 18)} WETH`);
  console.log(`tokensOwed1:  ${pos.tokensOwed1.toString()}                  = ${formatUnits(pos.tokensOwed1, 6)} USD₮0`);

  // 3. Cantidad de NFTs que tiene la wallet
  const nftCount = await pm.balanceOf(WALLET);
  console.log(`\nbalanceOf(wallet) en PositionManager: ${nftCount.toString()} NFTs`);

  // 4. Listar todos los tokenIds que posee la wallet (hasta los primeros 10)
  console.log(`\nTokenIds en la wallet (max 10):`);
  for (let i = 0n; i < (nftCount > 10n ? 10n : nftCount); i += 1n) {
    try {
      const id = await pm.tokenOfOwnerByIndex(WALLET, i);
      const marker = id === TOKEN_ID ? '   ← #5412248 (target)' : '';
      console.log(`  [${i}] ${id.toString()}${marker}`);
    } catch {}
  }

  // 5. Balance ERC-20 que el PositionManager tiene de WETH y USD₮0
  // Esto demuestra que el contrato físicamente tiene los tokens en escrow.
  const weth = new Contract(WETH, ERC20_ABI, provider);
  const usdt0 = new Contract(USDT0, ERC20_ABI, provider);
  const [pmWeth, pmUsdt0] = await Promise.all([
    weth.balanceOf(POSITION_MANAGER),
    usdt0.balanceOf(POSITION_MANAGER),
  ]);
  console.log(`\n--- Balances del PositionManager (escrow global de TODAS las posiciones) ---`);
  console.log(`PositionManager WETH:   ${formatUnits(pmWeth, 18)} WETH`);
  console.log(`PositionManager USD₮0:  ${formatUnits(pmUsdt0, 6)} USD₮0`);
  console.log(`(Lo que le corresponde a tu posición es el subconjunto reservado en tokensOwed0/1)`);

  // 6. Balance de la wallet (lo que ya tiene en su poder)
  const [walletWeth, walletUsdt0] = await Promise.all([
    weth.balanceOf(WALLET),
    usdt0.balanceOf(WALLET),
  ]);
  console.log(`\n--- Balances actuales de TU wallet (lo que ya tenés) ---`);
  console.log(`Wallet WETH:   ${formatUnits(walletWeth, 18)} WETH`);
  console.log(`Wallet USD₮0:  ${formatUnits(walletUsdt0, 6)} USD₮0`);

  return {
    owner,
    liquidity: pos.liquidity,
    tokensOwed0: pos.tokensOwed0,
    tokensOwed1: pos.tokensOwed1,
  };
}

async function main() {
  const results = [];
  for (const rpc of RPCS) {
    try {
      const r = await traceVia(rpc);
      if (r) results.push({ rpc: rpc.name, ...r });
    } catch (err) {
      console.log(`\n[${rpc.name}] FATAL: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`CONSENSO ENTRE RPCs (${results.length} fuentes verificadas)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const r of results) {
    console.log(`${r.rpc.padEnd(15)}: liquidity=${r.liquidity}, tokensOwed0=${r.tokensOwed0}, tokensOwed1=${r.tokensOwed1}`);
  }

  if (results.length >= 2) {
    const firstOwed0 = results[0].tokensOwed0;
    const firstOwed1 = results[0].tokensOwed1;
    const allMatch = results.every((r) =>
      r.tokensOwed0 === firstOwed0 && r.tokensOwed1 === firstOwed1
    );
    console.log(`\nTodos los RPCs coinciden: ${allMatch ? '✓ SÍ' : '✗ NO'}`);
    if (allMatch && firstOwed0 > 0n) {
      console.log(`\n✓ CONFIRMADO: ${formatUnits(firstOwed0, 18)} WETH + ${formatUnits(firstOwed1, 6)} USD₮0`);
      console.log(`✓ Recuperables vía collect() desde la wallet ${WALLET}`);
    }
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
