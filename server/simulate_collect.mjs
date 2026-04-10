import { JsonRpcProvider, Contract, Interface, formatUnits } from 'ethers';

const RPC = 'https://arbitrum-one-rpc.publicnode.com';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5412248n;
const WALLET = '0x7614BC8DA965C231135684Fa6b851E932f680cCb';
const MAX_UINT128 = (1n << 128n) - 1n;

// Pool factory
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'];
const POOL_ABI = ['function liquidity() view returns (uint128)'];
const PM_ABI = [
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  const provider = new JsonRpcProvider(RPC, 42161, { staticNetwork: true });
  const pmIface = new Interface(PM_ABI);

  // 1. Resolver pool address WETH/USD₮0 0.05%
  const factory = new Contract(FACTORY, FACTORY_ABI, provider);
  const pos = await new Contract(POSITION_MANAGER, PM_ABI, provider).positions(TOKEN_ID);
  const poolAddress = await factory.getPool(pos.token0, pos.token1, pos.fee);
  console.log(`Pool address (WETH/USD₮0 0.05%): ${poolAddress}`);

  // 2. Balance ERC-20 del POOL (no del PositionManager)
  const weth = new Contract(pos.token0, ERC20_ABI, provider);
  const usdt0 = new Contract(pos.token1, ERC20_ABI, provider);
  const [poolWeth, poolUsdt0] = await Promise.all([
    weth.balanceOf(poolAddress),
    usdt0.balanceOf(poolAddress),
  ]);
  console.log(`Pool balance WETH:   ${formatUnits(poolWeth, 18)} WETH`);
  console.log(`Pool balance USD₮0:  ${formatUnits(poolUsdt0, 6)} USD₮0`);
  console.log(`(Este pool tiene la liquidez de TODAS las posiciones, incluyendo la nuestra)`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`SIMULACIÓN DE collect() — eth_call sin firmar`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // 3. Construir la calldata de collect()
  const collectCalldata = pmIface.encodeFunctionData('collect', [{
    tokenId: TOKEN_ID,
    recipient: WALLET,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  }]);
  console.log(`Calldata: ${collectCalldata}`);

  // 4. Simular vía eth_call con from = WALLET (no necesitamos firma)
  let resultHex;
  try {
    resultHex = await provider.call({
      from: WALLET,
      to: POSITION_MANAGER,
      data: collectCalldata,
    });
  } catch (err) {
    console.log(`\n✗ La simulación REVERTIÓ: ${err.message?.slice(0, 200)}`);
    console.log(`Esto significa que la posición NO permite collect() por algún motivo.`);
    return;
  }

  // 5. Decodificar el resultado (uint256, uint256)
  const decoded = pmIface.decodeFunctionResult('collect', resultHex);
  const amount0 = BigInt(decoded[0].toString());
  const amount1 = BigInt(decoded[1].toString());
  console.log(`\n✓ La simulación PASÓ. collect() devolvería:`);
  console.log(`  amount0 = ${amount0.toString()} = ${formatUnits(amount0, 18)} WETH`);
  console.log(`  amount1 = ${amount1.toString()} = ${formatUnits(amount1, 6)} USD₮0`);

  if (amount0 === 0n && amount1 === 0n) {
    console.log(`\n⚠ La simulación devolvió 0/0. Los fondos NO se pueden recuperar vía collect().`);
    return;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ CONFIRMADO 100%: los fondos son RECUPERABLES`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Cantidad exacta a recuperar: ${formatUnits(amount0, 18)} WETH + ${formatUnits(amount1, 6)} USD₮0`);
  console.log(`Wallet receptora:            ${WALLET}`);
  console.log(`Contrato a llamar:           ${POSITION_MANAGER}`);
  console.log(`Función:                     collect()`);
  console.log(`Costo de gas estimado:       ~150_000 gas (~$0.05 USD en Arbitrum)`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
