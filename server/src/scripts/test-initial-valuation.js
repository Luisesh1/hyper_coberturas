#!/usr/bin/env node
/**
 * Pruebas a nivel consola para encontrar la forma correcta de estimar el
 * valor inicial de una posición LP de Uniswap V3 / V4.
 *
 * Compara 5 métodos de estimación contra una posición real on-chain:
 *   1. liquidityToTokenAmounts(L, sqrtP_actual, ticks)  → valor con precio actual
 *   2. liquidityToTokenAmounts(L, sqrtP_mint, ticks)    → valor al precio del mint
 *   3. extractV3MintInput(tx)                            → amount0Desired/amount1Desired del calldata
 *   4. extractOutgoingTokenTransfers(receipt)            → amounts reales del receipt
 *   5. inferSpotPriceFromLpAmounts(amounts, L, ticks)    → derivar precio desde amounts
 *
 * Uso:
 *   node src/scripts/test-initial-valuation.js \
 *     --network arbitrum --version v3 --token-id 5380500
 */

require('dotenv').config();
const { test } = require('node:test');
const { ethers } = require('ethers');

const uniswapService = require('../services/uniswap.service');
const { SUPPORTED_NETWORKS } = uniswapService;
const HAS_TOKEN_ID_ARG = process.argv.some((arg) => arg === '--token-id' || arg.startsWith('--token-id='));

function getNetworkConfig(name) {
  const cfg = SUPPORTED_NETWORKS[String(name || '').toLowerCase()];
  if (!cfg) throw new Error(`Network desconocida: ${name}`);
  return cfg;
}

const _providerCache = new Map();
function getProvider(networkConfig) {
  if (_providerCache.has(networkConfig.id)) return _providerCache.get(networkConfig.id);
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, { staticNetwork: true });
  _providerCache.set(networkConfig.id, provider);
  return provider;
}

const V3_POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const POSITION_MANAGER_NFT_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_ADDRESS_TOPIC = '0x' + '0'.repeat(64);
// event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const INCREASE_LIQUIDITY_TOPIC = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
// event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const DECREASE_LIQUIDITY_TOPIC = ethers.id('DecreaseLiquidity(uint256,uint128,uint256,uint256)');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key.startsWith('--') && next && !next.startsWith('--')) {
      args[key.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function fmtNum(value, digits = 6) {
  if (value == null) return 'null';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtUsd(value) {
  if (value == null) return 'null';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function loadTokenInfo(provider, address) {
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  return { address, symbol, decimals: Number(decimals) };
}

async function findMintTxHash(provider, positionManagerAddress, tokenId) {
  // Buscar el evento Transfer(0x0, owner, tokenId) que indica el mint del NFT.
  // Iteramos hacia atrás en chunks (max 1000 blocks por eth_getLogs en algunos RPCs).
  const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const latest = await provider.getBlockNumber();
  const STEP = 10000;
  for (let to = latest; to >= 0; to -= STEP) {
    const from = Math.max(0, to - STEP + 1);
    try {
      const logs = await provider.getLogs({
        address: positionManagerAddress,
        topics: [POSITION_MANAGER_NFT_TRANSFER_TOPIC, ZERO_ADDRESS_TOPIC, null, tokenIdHex],
        fromBlock: from,
        toBlock: to,
      });
      if (logs && logs.length > 0) {
        return { txHash: logs[0].transactionHash, blockNumber: logs[0].blockNumber };
      }
    } catch (err) {
      console.warn(`  ⚠ getLogs ${from}-${to} failed: ${err.message}`);
    }
  }
  return null;
}

function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function sqrtPriceX96ToFloat(sqrtPriceX96) {
  const Q96 = 2n ** 96n;
  const num = Number(BigInt(sqrtPriceX96)) / Number(Q96);
  return num;
}

function sqrtPriceToPrice(sqrtPriceFloat, decimals0, decimals1) {
  return (sqrtPriceFloat ** 2) * Math.pow(10, decimals0 - decimals1);
}

function liquidityToAmounts({ liquidity, sqrtPriceFloat, sqrtLowerFloat, sqrtUpperFloat, decimals0, decimals1 }) {
  const L = Number(liquidity);
  const lower = Math.min(sqrtLowerFloat, sqrtUpperFloat);
  const upper = Math.max(sqrtLowerFloat, sqrtUpperFloat);
  let amount0Raw = 0;
  let amount1Raw = 0;
  if (sqrtPriceFloat <= lower) {
    amount0Raw = L * ((upper - lower) / (lower * upper));
  } else if (sqrtPriceFloat < upper) {
    amount0Raw = L * ((upper - sqrtPriceFloat) / (sqrtPriceFloat * upper));
    amount1Raw = L * (sqrtPriceFloat - lower);
  } else {
    amount1Raw = L * (upper - lower);
  }
  return {
    amount0: amount0Raw / Math.pow(10, decimals0),
    amount1: amount1Raw / Math.pow(10, decimals1),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const network = args.network || 'arbitrum';
  const version = args.version || 'v3';
  const tokenId = args['token-id'] || args.tokenId;

  if (!tokenId) {
    console.error('Uso: node test-initial-valuation.js --network arbitrum --version v3 --token-id <tokenId>');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`PRUEBA DE ESTIMACIÓN DE VALOR INICIAL — ${network} ${version} #${tokenId}`);
  console.log('='.repeat(80));

  const networkConfig = getNetworkConfig(network);
  const provider = getProvider(networkConfig);

  if (version !== 'v3') {
    console.log('NOTA: V4 requiere queries especiales (PoolManager + StateView). Por simplicidad, este test solo cubre V3.');
    process.exit(0);
  }

  const positionManagerAddress = networkConfig.deployments.v3.positionManager;
  const factoryAddress = networkConfig.deployments.v3.eventSource;
  const positionManager = new ethers.Contract(positionManagerAddress, V3_POSITION_MANAGER_ABI, provider);
  const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);

  console.log('\n[1/6] Cargando posición desde NonfungiblePositionManager...');
  const position = await positionManager.positions(tokenId);
  const owner = await positionManager.ownerOf(tokenId);
  const token0 = await loadTokenInfo(provider, position.token0);
  const token1 = await loadTokenInfo(provider, position.token1);

  console.log(`  owner       : ${owner}`);
  console.log(`  token0      : ${token0.symbol} (${token0.address}, ${token0.decimals} dec)`);
  console.log(`  token1      : ${token1.symbol} (${token1.address}, ${token1.decimals} dec)`);
  console.log(`  fee         : ${Number(position.fee)} (${(Number(position.fee) / 10000).toFixed(2)}%)`);
  console.log(`  tickLower   : ${Number(position.tickLower)}`);
  console.log(`  tickUpper   : ${Number(position.tickUpper)}`);
  console.log(`  liquidity   : ${position.liquidity.toString()}`);
  console.log(`  tokensOwed0 : ${position.tokensOwed0.toString()}`);
  console.log(`  tokensOwed1 : ${position.tokensOwed1.toString()}`);

  console.log('\n[2/6] Cargando pool y precio actual...');
  const poolAddress = await factory.getPool(token0.address, token1.address, position.fee);
  const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
  const slot0 = await pool.slot0();
  const sqrtCurrentFloat = sqrtPriceX96ToFloat(slot0.sqrtPriceX96);
  const priceCurrent = sqrtPriceToPrice(sqrtCurrentFloat, token0.decimals, token1.decimals);
  const tickCurrent = Number(slot0.tick);
  console.log(`  pool        : ${poolAddress}`);
  console.log(`  sqrtPriceX96: ${slot0.sqrtPriceX96.toString()}`);
  console.log(`  tick actual : ${tickCurrent}`);
  console.log(`  precio actual: ${fmtNum(priceCurrent, 6)} ${token1.symbol}/${token0.symbol}`);

  const priceLower = tickToPrice(Number(position.tickLower), token0.decimals, token1.decimals);
  const priceUpper = tickToPrice(Number(position.tickUpper), token0.decimals, token1.decimals);
  console.log(`  rango       : ${fmtNum(priceLower, 4)} - ${fmtNum(priceUpper, 4)} ${token1.symbol}/${token0.symbol}`);

  console.log('\n[3/6] Buscando tx de mint del NFT...');
  const mintInfo = await findMintTxHash(provider, positionManagerAddress, tokenId);
  if (!mintInfo) {
    console.log('  ❌ No se pudo encontrar el tx de mint.');
    process.exit(1);
  }
  console.log(`  txHash      : ${mintInfo.txHash}`);
  console.log(`  blockNumber : ${mintInfo.blockNumber}`);

  const [tx, receipt, mintBlock] = await Promise.all([
    provider.getTransaction(mintInfo.txHash),
    provider.getTransactionReceipt(mintInfo.txHash),
    provider.getBlock(mintInfo.blockNumber),
  ]);
  console.log(`  blockTime   : ${new Date(mintBlock.timestamp * 1000).toISOString()}`);

  console.log('\n[4/6] MÉTODO 1 — liquidityToTokenAmounts con precio del mint block...');
  // Para precio del mint block: en V3 podemos hacer slot0 historical via callStatic con blockTag
  let priceAtMint = null;
  let amountsAtMint = null;
  try {
    const slot0Historical = await pool.slot0({ blockTag: mintInfo.blockNumber });
    const sqrtMintFloat = sqrtPriceX96ToFloat(slot0Historical.sqrtPriceX96);
    priceAtMint = sqrtPriceToPrice(sqrtMintFloat, token0.decimals, token1.decimals);
    const sqrtLower = Math.pow(1.0001, Number(position.tickLower) / 2);
    const sqrtUpper = Math.pow(1.0001, Number(position.tickUpper) / 2);
    amountsAtMint = liquidityToAmounts({
      liquidity: position.liquidity,
      sqrtPriceFloat: sqrtMintFloat,
      sqrtLowerFloat: sqrtLower,
      sqrtUpperFloat: sqrtUpper,
      decimals0: token0.decimals,
      decimals1: token1.decimals,
    });
    console.log(`  precio @ mint : ${fmtNum(priceAtMint, 6)} ${token1.symbol}/${token0.symbol}`);
    console.log(`  amount0       : ${fmtNum(amountsAtMint.amount0, 8)} ${token0.symbol}`);
    console.log(`  amount1       : ${fmtNum(amountsAtMint.amount1, 6)} ${token1.symbol}`);
    // USD value usando que token1 es stable (USDC, USDT)
    const stableSymbol = /usd/i.test(token1.symbol);
    if (stableSymbol) {
      const valueUsd = amountsAtMint.amount1 + amountsAtMint.amount0 * priceAtMint;
      console.log(`  valor USD     : ${fmtUsd(valueUsd)}  (token1 stable)`);
    } else {
      console.log('  valor USD     : (no calculable, ningún token es stable)');
    }
  } catch (err) {
    console.log(`  ❌ Error obteniendo slot0 histórico: ${err.message}`);
  }

  console.log('\n[5/6] MÉTODO 2 — extractV3MintInput (calldata del tx)...');
  try {
    const inputs = uniswapService.extractMintInputAmounts({
      tx,
      networkConfig,
      version: 'v3',
      token0,
      token1,
    });
    if (inputs) {
      console.log(`  amount0Desired: ${fmtNum(inputs.amount0, 8)} ${token0.symbol}`);
      console.log(`  amount1Desired: ${fmtNum(inputs.amount1, 6)} ${token1.symbol}`);
      console.log(`  source        : ${inputs.source}`);
      if (priceAtMint != null) {
        const stableSymbol = /usd/i.test(token1.symbol);
        if (stableSymbol) {
          const valueUsd = Number(inputs.amount1) + Number(inputs.amount0) * priceAtMint;
          console.log(`  valor USD     : ${fmtUsd(valueUsd)}`);
        }
      }
    } else {
      console.log('  ❌ No se pudo decodificar el calldata (¿router agregador?)');
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  console.log('\n[6/6] MÉTODO 3 — Transfers del receipt (lo que la wallet realmente envió)...');
  try {
    let amount0Raw = 0n;
    let amount1Raw = 0n;
    const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
    const ownerLower = owner.toLowerCase();
    for (const log of receipt.logs || []) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
      // topic[1] = from, topic[2] = to
      const from = '0x' + log.topics[1].slice(26).toLowerCase();
      if (from !== ownerLower) continue;
      const value = BigInt(log.data);
      if (log.address.toLowerCase() === token0.address.toLowerCase()) amount0Raw += value;
      if (log.address.toLowerCase() === token1.address.toLowerCase()) amount1Raw += value;
    }
    const amount0 = Number(ethers.formatUnits(amount0Raw, token0.decimals));
    const amount1 = Number(ethers.formatUnits(amount1Raw, token1.decimals));
    console.log(`  amount0 enviado: ${fmtNum(amount0, 8)} ${token0.symbol}`);
    console.log(`  amount1 enviado: ${fmtNum(amount1, 6)} ${token1.symbol}`);
    if (priceAtMint != null) {
      const stableSymbol = /usd/i.test(token1.symbol);
      if (stableSymbol) {
        const valueUsd = amount1 + amount0 * priceAtMint;
        console.log(`  valor USD      : ${fmtUsd(valueUsd)}  ⭐ (más exacto)`);
      }
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  console.log('\n[7/8] MÉTODO 4 — Cost basis acumulado por IncreaseLiquidity events del NFT...');
  // Suma TODOS los IncreaseLiquidity y RESTA los DecreaseLiquidity del tokenId.
  // Cada deposit/retiro se valua a USD usando el precio (slot0) del bloque
  // respectivo. Esta es la forma matemáticamente correcta de calcular el cost
  // basis de un LP que pudo haber sido modificado después del mint inicial.
  let cumulativeAmount0 = 0n;
  let cumulativeAmount1 = 0n;
  let cumulativeUsd = 0;
  const lifetimeEvents = [];
  try {
    const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
    const latest = await provider.getBlockNumber();
    const STEP = 10000;
    for (const [topic, kind, sign] of [
      [INCREASE_LIQUIDITY_TOPIC, 'increase', 1n],
      [DECREASE_LIQUIDITY_TOPIC, 'decrease', -1n],
    ]) {
      for (let to = latest; to >= 0; to -= STEP) {
        const from = Math.max(0, to - STEP + 1);
        let logs;
        try {
          logs = await provider.getLogs({
            address: positionManagerAddress,
            topics: [topic, tokenIdHex],
            fromBlock: from,
            toBlock: to,
          });
        } catch {
          continue;
        }
        for (const log of logs) {
          // data layout: liquidity (uint128) | amount0 (uint256) | amount1 (uint256)
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['uint128', 'uint256', 'uint256'],
            log.data,
          );
          lifetimeEvents.push({
            kind,
            sign,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            liquidity: decoded[0].toString(),
            amount0Raw: decoded[1],
            amount1Raw: decoded[2],
          });
        }
      }
    }

    lifetimeEvents.sort((a, b) => a.blockNumber - b.blockNumber);
    console.log(`  events encontrados: ${lifetimeEvents.length} (${lifetimeEvents.filter((e) => e.kind === 'increase').length} increases / ${lifetimeEvents.filter((e) => e.kind === 'decrease').length} decreases)`);

    for (const evt of lifetimeEvents) {
      const a0 = Number(ethers.formatUnits(evt.amount0Raw, token0.decimals));
      const a1 = Number(ethers.formatUnits(evt.amount1Raw, token1.decimals));
      cumulativeAmount0 += evt.sign * evt.amount0Raw;
      cumulativeAmount1 += evt.sign * evt.amount1Raw;
      // Precio histórico del bloque del evento
      let priceAt = priceCurrent;
      try {
        const slot0Hist = await pool.slot0({ blockTag: evt.blockNumber });
        priceAt = sqrtPriceToPrice(sqrtPriceX96ToFloat(slot0Hist.sqrtPriceX96), token0.decimals, token1.decimals);
      } catch {
        // Algunos nodos no exponen estado histórico para ese bloque; mantenemos el último precio conocido.
      }
      // estimateUsdValueFromPair: si token1 stable → a1 + a0*price, si token0 stable → a0 + a1/price
      let evtUsd = null;
      if (/usd|dai/i.test(token1.symbol)) {
        evtUsd = a1 + a0 * priceAt;
      } else if (/usd|dai/i.test(token0.symbol)) {
        // priceCurrent es token1/token0 humanos: ej WETH/USDC ≈ 0.0004 → 1/0.0004 = 2500 USDC/WETH
        evtUsd = a0 + (priceAt > 0 ? a1 / priceAt : 0);
      }
      cumulativeUsd += Number(evt.sign) * (evtUsd || 0);
      console.log(`    ${evt.kind.padEnd(8)} block ${evt.blockNumber}  ${fmtNum(a0, 8)} ${token0.symbol} + ${fmtNum(a1, 6)} ${token1.symbol}  @ ${fmtNum(priceAt, 6)}  →  ${fmtUsd(evtUsd)}`);
    }
    const cum0 = Number(ethers.formatUnits(cumulativeAmount0, token0.decimals));
    const cum1 = Number(ethers.formatUnits(cumulativeAmount1, token1.decimals));
    console.log(`  COST BASIS NETO    : ${fmtNum(cum0, 8)} ${token0.symbol} + ${fmtNum(cum1, 6)} ${token1.symbol}`);
    console.log(`  COST BASIS USD     : ${fmtUsd(cumulativeUsd)}  ⭐⭐ (cost basis acumulado real)`);
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }

  console.log('\n[8/8] Comparando con resolveInitialValuation() actual del bot...');
  try {
    const valuation = await uniswapService.resolveInitialValuation({
      provider,
      networkConfig,
      apiKey: null,
      record: {
        identifier: String(tokenId),
        version: 'v3',
        owner,
        creator: owner,
        txHash: mintInfo.txHash,
        mintBlockNumber: mintInfo.blockNumber,
        positionLiquidity: position.liquidity.toString(),
        tickLower: Number(position.tickLower),
        tickUpper: Number(position.tickUpper),
      },
      positionLiquidity: position.liquidity.toString(),
      token0,
      token1,
      historicalPrice: priceAtMint != null
        ? { price: priceAtMint, accuracy: 'exact', blockNumber: mintInfo.blockNumber }
        : null,
      historicalAmounts: null,
      currentValueUsd: null,
      unclaimedFeesUsd: null,
      priceCurrent,
    });
    console.log(`  initialValueUsd       : ${fmtUsd(valuation.initialValueUsd)}`);
    console.log(`  initialValueUsdSource : ${valuation.initialValueUsdSource}`);
    console.log(`  initialValueUsdAccuracy: ${valuation.initialValueUsdAccuracy}`);
    console.log(`  initialAmount0        : ${fmtNum(valuation.initialAmount0, 8)}`);
    console.log(`  initialAmount1        : ${fmtNum(valuation.initialAmount1, 6)}`);
    console.log(`  warnings              : ${(valuation.valuationWarnings || []).length}`);
  } catch (err) {
    console.log(`  ❌ Error llamando a resolveInitialValuation: ${err.message}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('CONCLUSIÓN:');
  console.log('  - Método 1 (math + slot0 histórico): exacto para liquidez ACTUAL al precio del mint.');
  console.log('    NO refleja increases/decreases posteriores.');
  console.log('  - Método 2 (calldata): da los Desired del mint inicial, ignora increases.');
  console.log('  - Método 3 (transfers del receipt): refleja los amounts REALMENTE depositados en el mint inicial.');
  console.log('    NO captura increases/decreases posteriores.');
  console.log('  - Método 4 (cost basis acumulado): suma TODOS los IncreaseLiquidity y resta');
  console.log('    los DecreaseLiquidity, valuando cada uno al precio histórico de su bloque.');
  console.log('    Esta es la forma correcta de medir el cost basis de un LP modificado.');
  console.log('');
  console.log('  Si los métodos 1-3 difieren del 4, la posición tuvo modificaciones después del mint.');
  console.log('  El bot debería usar el método 4 como fuente PRIMARIA del valor inicial.');
  console.log('='.repeat(80));
}

if (!HAS_TOKEN_ID_ARG) {
  test('manual valuation script is skipped without CLI arguments', { skip: 'manual utility' }, () => {});
  module.exports = { main };
} else {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
