#!/usr/bin/env node
/**
 * E2E on-chain del ciclo de vida completo de un LP, contra testnet.
 *
 * Corre en proceso las mismas funciones que usan las rutas (`buildFundingPlan`
 * + `preparePositionAction`) y firma cada tx del `txPlan` con una burner key,
 * en vez de mandarla al browser. Cubre:
 *
 *   funding-plan -> create-position -> increase -> decrease -> close
 *
 * POR QUE NO USA `wallet.sendTransaction(tx)` DIRECTO
 * ---------------------------------------------------
 * Ese camino le pasa el `value` a ethers, que lo re-normaliza a BigInt y
 * esconde los errores de codificacion. La wallet real hace otra cosa: manda el
 * objeto tal cual por `eth_sendTransaction`, con los strings crudos que
 * devolvio el servidor. Asi fue como `value: '0x0de0b6b3a7640000'` (salida de
 * `ethers.toBeHex`, con cero a la izquierda) sobrevivio meses en el fondeo:
 * los nodos estrictos lo rechazan con "hex number with leading zero digits" y
 * la wallet lo mostraba como "Missing or invalid parameters [codigo -32000]".
 *
 * Por eso `executeTxPlan` replica el camino del cliente: arma los params igual
 * que `buildTransactionParams` del front, los valida como QUANTITY y llama a
 * `eth_estimateGas` con el objeto literal ANTES de firmar. Un value mal
 * codificado revienta ahi, con el nombre del paso y no con un error opaco.
 *
 * USO
 * ---
 *   export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22
 *   cd server
 *   E2E_TESTNET_PRIVATE_KEY=0x... NODE_ENV=development \
 *     node src/scripts/e2e-testnet-flow.js
 *
 *   --dry-run   prepara y valida todos los planes sin firmar nada (no
 *               necesita fondos; igual detecta params mal formados porque
 *               llama a eth_estimateGas).
 *   --keep      no cierra la posicion al final (para inspeccionarla a mano).
 *
 * La wallet necesita ETH y USDC de testnet:
 * https://www.alchemy.com/faucets/base-sepolia
 */

require('dotenv').config();

const { ethers } = require('ethers');

const smartPoolCreatorService = require('../services/smart-pool-creator.service');
const { preparePositionAction } = require('../services/uniswap/actions/finalize');
const { getNetworkConfig, getProvider } = require('../services/uniswap/actions/helpers');
const { getKnownTokens, sortTokensByAddress } = require('../services/smart-pool-creator.service');

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_POSITION = process.argv.includes('--keep');

const CONFIG = {
  privateKey: process.env.E2E_TESTNET_PRIVATE_KEY,
  network: process.env.E2E_TESTNET_NETWORK || 'base-sepolia',
  version: (process.env.E2E_TESTNET_VERSION || 'v4').toLowerCase(),
  fee: Number(process.env.E2E_TESTNET_FEE || 3000),
  totalUsdTarget: Number(process.env.E2E_TESTNET_USD || 12),
  increaseUsdTarget: Number(process.env.E2E_TESTNET_INCREASE_USD || 6),
  rangeWidthPct: Number(process.env.E2E_TESTNET_RANGE_PCT || 20),
  slippageBps: Number(process.env.E2E_TESTNET_SLIPPAGE_BPS || 100),
  receiptTimeoutMs: Number(process.env.E2E_TESTNET_RECEIPT_TIMEOUT_MS || 180_000),
  useNative: process.env.E2E_TESTNET_NATIVE === '1',
  // Pasos a saltear, separados por coma (p.ej. increase). Sirve para seguir
  // validando el resto del ciclo cuando un paso tiene un bug conocido.
  skip: String(process.env.E2E_TESTNET_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
};

// Un QUANTITY de JSON-RPC es hex compacto sin ceros a la izquierda.
const RPC_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─── Salida ──────────────────────────────────────────────────────────

const stepResults = [];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function logStep(name) {
  log(`\n─── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
}

async function runStep(name, fn) {
  if (CONFIG.skip.some((s) => name.startsWith(s))) {
    logStep(`${name} [SALTEADO]`);
    stepResults.push({ name, ok: true, skipped: true, ms: 0 });
    return null;
  }
  logStep(name);
  const startedAt = Date.now();
  try {
    const result = await fn();
    stepResults.push({ name, ok: true, ms: Date.now() - startedAt });
    return result;
  } catch (err) {
    stepResults.push({ name, ok: false, ms: Date.now() - startedAt, error: err.message });
    throw err;
  }
}

// ─── Ejecucion de transacciones ──────────────────────────────────────

/**
 * Replica `buildTransactionParams` del cliente (client/src/lib/wallet/
 * transaction-utils.js) SIN normalizar: queremos ver exactamente lo que el
 * servidor emitio, que es lo que llega a la wallet.
 */
function buildRawTxParams(tx, from) {
  const params = { from, to: tx.to, data: tx.data, value: tx.value || '0x0' };
  const gas = tx.gas || tx.gasEstimate || tx.gasLimit;
  if (gas) params.gas = gas;
  return params;
}

function assertTxPlanShape(tx, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tx.to || '').trim())) {
    throw new Error(`[${label}] destino invalido: to=${tx.to}`);
  }
  const movesValue = tx.value && tx.value !== '0x0';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(String(tx.data || '')) && !movesValue) {
    throw new Error(`[${label}] calldata invalida: data=${tx.data}`);
  }
  for (const field of ['value', 'gas', 'gasEstimate', 'gasLimit']) {
    const raw = tx[field];
    if (raw == null) continue;
    if (!RPC_QUANTITY.test(String(raw))) {
      throw new Error(
        `[${label}] ${field}="${raw}" no es un QUANTITY valido de JSON-RPC. `
        + 'Con ceros a la izquierda el nodo rechaza la tx entera y la wallet '
        + 'lo reporta como "Missing or invalid parameters [codigo -32000]". '
        + 'Usar ethers.toQuantity(), no ethers.toBeHex().'
      );
    }
  }
}

async function executeTxPlan(txPlan, { wallet, provider, label, nonceRef }) {
  const receipts = [];
  if (!Array.isArray(txPlan) || txPlan.length === 0) {
    log(`  (${label}: txPlan vacio)`);
    return receipts;
  }

  // El nonce se lleva a mano y COMPARTIDO entre todos los planes de la
  // corrida. ethers lo resuelve por RPC y cachea el resultado unos
  // milisegundos; mandando txs de corrido —y mas contra un nodo que mina al
  // instante— la siguiente reusa el nonce de la anterior y muere con "nonce
  // too low". Releerlo al empezar cada plan no alcanza: el cache sobrevive
  // entre planes.
  if (nonceRef.value == null) {
    nonceRef.value = await provider.getTransactionCount(wallet.address, 'pending');
  }

  for (const [index, tx] of txPlan.entries()) {
    const stepLabel = `${label} ${index + 1}/${txPlan.length} ${tx.kind || 'tx'}`;
    assertTxPlanShape(tx, stepLabel);

    const rawParams = buildRawTxParams(tx, wallet.address);

    // La validacion de params del nodo, con el objeto crudo — el mismo
    // camino que recorre la wallet. Aca es donde muere un value mal
    // codificado, antes de gastar gas.
    let estimatedGas;
    try {
      estimatedGas = await provider.send('eth_estimateGas', [rawParams]);
    } catch (err) {
      const detail = err?.error?.message || err?.info?.error?.message || err.message;
      throw new Error(`[${stepLabel}] eth_estimateGas rechazo los params: ${detail}`);
    }

    log(`  ${stepLabel}: to=${tx.to} value=${rawParams.value} gas≈${BigInt(estimatedGas)}`);

    if (DRY_RUN) {
      receipts.push(null);
      continue;
    }

    const sent = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(rawParams.value),
      gasLimit: (BigInt(estimatedGas) * 125n) / 100n,
      nonce: nonceRef.value++,
    });
    const receipt = await sent.wait(1, CONFIG.receiptTimeoutMs);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`[${stepLabel}] la tx ${sent.hash} revirtio on-chain`);
    }
    log(`    ✓ ${sent.hash}`);
    receipts.push(receipt);
  }

  return receipts;
}

/**
 * El tokenId de la posicion recien minteada sale del Transfer(0x0 -> wallet)
 * que emite el PositionManager.
 */
function extractMintedTokenId(receipts, positionManagerAddress, walletAddress) {
  const pm = positionManagerAddress.toLowerCase();
  const owner = walletAddress.toLowerCase();
  for (const receipt of receipts) {
    for (const logEntry of receipt?.logs || []) {
      if (logEntry.address.toLowerCase() !== pm) continue;
      if (logEntry.topics[0] !== TRANSFER_TOPIC || logEntry.topics.length < 4) continue;
      const from = `0x${logEntry.topics[1].slice(-40)}`.toLowerCase();
      const to = `0x${logEntry.topics[2].slice(-40)}`.toLowerCase();
      if (from !== ethers.ZeroAddress.toLowerCase() || to !== owner) continue;
      return BigInt(logEntry.topics[3]).toString();
    }
  }
  return null;
}

// ─── Flujo ───────────────────────────────────────────────────────────

function resolvePair(network, networkConfig) {
  const known = getKnownTokens(network);
  const usdc = known.find((t) => t.symbol === 'USDC');
  // Con USE_NATIVE probamos el pool NATIVO/USDC, que es una currency distinta
  // del WRAPPED/USDC en v4 y tiene su propio camino de fondeo (unwrap) y de
  // pago (`value` + SWEEP).
  const base = CONFIG.useNative
    ? { symbol: networkConfig.nativeSymbol, address: ZERO_ADDRESS, decimals: 18, isNative: true }
    : known.find((t) => t.isWrappedNative);
  if (!base || !usdc) {
    throw new Error(`No hay par ${CONFIG.useNative ? 'nativo' : 'WETH'}/USDC conocido en ${network}`);
  }
  // El orden canonico lo define la address, no la preferencia del usuario.
  const { token0, token1 } = sortTokensByAddress(base, usdc);
  return { token0, token1 };
}

async function main() {
  if (!CONFIG.privateKey) {
    throw new Error(
      'Falta E2E_TESTNET_PRIVATE_KEY. Usa una wallet quemable con fondos de '
      + 'faucet, nunca una con capital real.'
    );
  }

  const networkConfig = getNetworkConfig(CONFIG.network);
  const provider = getProvider(networkConfig);

  // Guardarrail: este script firma y gasta. Si alguna vez apunta a mainnet
  // por un typo en el env, que muera aca.
  //
  // La excepcion es un fork local (anvil --fork-url): tiene el chainId y el
  // estado de la red real — pools con liquidez de verdad, que una testnet no
  // tiene — pero el dinero es de mentira. Se verifica preguntandole al nodo
  // por un metodo que SOLO existe en anvil: contra un RPC real esto falla y
  // el guardarrail se mantiene.
  let esFork = false;
  if (!networkConfig.isTestnet) {
    try {
      await provider.send('anvil_nodeInfo', []);
      esFork = true;
    } catch {
      esFork = false;
    }
    if (!esFork) {
      throw new Error(
        `${networkConfig.label} no es una testnet y el RPC configurado no es un fork local. `
        + 'Este script firma transacciones reales: solo corre contra redes con '
        + 'isTestnet=true o contra un fork de anvil.'
      );
    }
  }
  const wallet = new ethers.Wallet(CONFIG.privateKey, provider);
  const nonceRef = { value: null };
  const { token0, token1 } = resolvePair(CONFIG.network, networkConfig);

  log(`Red      : ${networkConfig.label} (chainId ${networkConfig.chainId})${esFork ? '  [FORK LOCAL]' : ''}`);
  log(`Version  : ${CONFIG.version}`);
  log(`Wallet   : ${wallet.address}`);
  log(`Par      : ${token0.symbol}/${token1.symbol} fee=${CONFIG.fee}`);
  log(`Objetivo : $${CONFIG.totalUsdTarget}${DRY_RUN ? '  [DRY-RUN: no firma]' : ''}`);

  const nativeBalance = await provider.getBalance(wallet.address);
  log(`Balance  : ${ethers.formatEther(nativeBalance)} ${networkConfig.nativeSymbol}`);
  if (nativeBalance === 0n && !DRY_RUN) {
    throw new Error(`La wallet no tiene ${networkConfig.nativeSymbol} para gas. Usa el faucet.`);
  }

  const basePayload = {
    network: CONFIG.network,
    version: CONFIG.version,
    walletAddress: wallet.address,
    token0Address: token0.address,
    token1Address: token1.address,
    fee: CONFIG.fee,
  };

  // 1. Funding plan ---------------------------------------------------
  // Necesita el precio actual para derivar el rango, asi que primero pide un
  // plan con un rango tentativo y despues lo recentra.
  const fundingPlan = await runStep('funding-plan', async () => {
    const preview = await smartPoolCreatorService.buildFundingPlan({
      ...basePayload,
      totalUsdTarget: CONFIG.totalUsdTarget,
      targetWeightToken0Pct: 50,
      rangeLowerPrice: 0.000001,
      rangeUpperPrice: 100_000_000,
      maxSlippageBps: CONFIG.slippageBps,
    });
    log(`  precio actual: ${preview.currentPrice}`);
    log(`  desplegable  : $${preview.fundingPlan.deployableUsd} (${preview.fundingPlan.swapCount} swaps)`);
    for (const warning of preview.warnings || []) log(`  ⚠ ${warning}`);
    return preview;
  });

  const width = CONFIG.rangeWidthPct / 100;
  const rangeLowerPrice = fundingPlan.currentPrice * (1 - width);
  const rangeUpperPrice = fundingPlan.currentPrice * (1 + width);
  log(`  rango        : ${rangeLowerPrice} … ${rangeUpperPrice}`);

  const createPayload = {
    ...basePayload,
    totalUsdTarget: CONFIG.totalUsdTarget,
    targetWeightToken0Pct: 50,
    rangeLowerPrice,
    rangeUpperPrice,
    maxSlippageBps: CONFIG.slippageBps,
    slippageBps: CONFIG.slippageBps,
    ...(CONFIG.version === 'v4'
      ? { poolId: fundingPlan.poolId, tickSpacing: fundingPlan.tickSpacing, hooks: fundingPlan.hooks }
      : {}),
  };

  // 2. Create position ------------------------------------------------
  const tokenId = await runStep('create-position', async () => {
    const prepared = await preparePositionAction({ action: 'create-position', payload: createPayload });
    const receipts = await executeTxPlan(prepared.txPlan, { wallet, provider, label: 'create', nonceRef });
    if (DRY_RUN) return null;

    const positionManager = networkConfig.deployments[CONFIG.version].positionManager;
    const minted = extractMintedTokenId(receipts, positionManager, wallet.address);
    if (!minted) throw new Error('No se pudo extraer el tokenId del mint');
    log(`  tokenId: ${minted}`);
    return minted;
  });

  const positionPayload = {
    network: CONFIG.network,
    version: CONFIG.version,
    walletAddress: wallet.address,
    positionIdentifier: tokenId,
    slippageBps: CONFIG.slippageBps,
    ...(CONFIG.version === 'v4'
      ? { poolId: fundingPlan.poolId, tickSpacing: fundingPlan.tickSpacing, hooks: fundingPlan.hooks }
      : {}),
  };

  if (DRY_RUN) {
    log('\n[DRY-RUN] No hay posicion on-chain: se omiten increase/decrease/close.');
    return;
  }

  // 3. Increase -------------------------------------------------------
  await runStep('increase-liquidity', async () => {
    const prepared = await preparePositionAction({
      action: 'increase-liquidity',
      payload: {
        ...positionPayload,
        totalUsdTarget: CONFIG.increaseUsdTarget,
        maxSlippageBps: CONFIG.slippageBps,
      },
    });
    await executeTxPlan(prepared.txPlan, { wallet, provider, label: 'increase', nonceRef });
  });

  // 4. Decrease 50% ---------------------------------------------------
  await runStep('decrease-liquidity 50%', async () => {
    const prepared = await preparePositionAction({
      action: 'decrease-liquidity',
      payload: { ...positionPayload, liquidityPercent: 50 },
    });
    await executeTxPlan(prepared.txPlan, { wallet, provider, label: 'decrease', nonceRef });
  });

  // 5. Close ----------------------------------------------------------
  if (KEEP_POSITION) {
    log(`\n[--keep] Se deja abierta la posicion ${tokenId}.`);
  } else {
    await runStep('close-keep-assets', async () => {
      const prepared = await preparePositionAction({
        action: 'close-keep-assets',
        payload: positionPayload,
      });
      await executeTxPlan(prepared.txPlan, { wallet, provider, label: 'close', nonceRef });
    });
  }
}

function printSummary() {
  logStep('resumen');
  for (const step of stepResults) {
    log(`  ${step.ok ? '✓' : '✗'} ${step.name} (${step.ms}ms)`);
  }
}

if (require.main === module) {
  main()
    .then(() => {
      printSummary();
      log('\nFlujo completo OK.');
      process.exit(0);
    })
    .catch((err) => {
      printSummary();
      log(`\n✗ ${err.message}`);
      if (process.env.E2E_TESTNET_DEBUG) log(err.stack);
      process.exit(1);
    });
}

// `assertTxPlanShape` es el guardarrail que convierte un "-32000" opaco en un
// error con nombre. Se exporta para poder testearlo sin red ni fondos.
module.exports = { assertTxPlanShape, buildRawTxParams, extractMintedTokenId };
