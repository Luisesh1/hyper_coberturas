const { ethers } = require('ethers');
const httpClient = require('../../shared/platform/http/http-client');
const config = require('../../config');
const logger = require('../logger.service');
const {
  UNIVERSAL_ROUTER_ABI,
  V4_ACTIONS,
  V4_POSITION_MANAGER_ABI,
  getUniversalRouterAddress,
} = require('../uniswap-v4-helpers.service');
const {
  compactNumber,
  tickToRawSqrtRatio,
} = require('./pool-math');
const {
  estimateUsdValueFromPair,
} = require('./pricing');

const DEFAULT_TIMEOUT_MS = config.uniswap.scanTimeoutMs;
const HISTORICAL_PRICE_BLOCK_OFFSETS = [0, -1, -5, -25, -100, -500, -5000];
const ETHERSCAN_PROXY_API_URL = 'https://api.etherscan.io/v2/api';
const TRANSFER_EVENT_TOPIC = ethers.id('Transfer(address,address,uint256)');
const V4_PLAN_DECODER = ethers.AbiCoder.defaultAbiCoder();
const V4_MINT_PARAM_TYPES = [
  'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
  'int24',
  'int24',
  'uint256',
  'uint128',
  'uint128',
  'address',
  'bytes',
];
const V3_MINT_ABI = [
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

function normalizeAddress(address) {
  if (!address) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return String(address).toLowerCase();
  }
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function formatTokenAmount(value, decimals) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return '0';
  }
}

function buildLiquiditySummary(status, parts) {
  return {
    status,
    text: parts.filter(Boolean).join(' · '),
  };
}

function buildWarningsWithDedup(warnings) {
  return [...new Set((warnings || []).filter(Boolean))];
}

function getAccuracyFromSource(source) {
  if (source === 'rpc_exact') return 'exact';
  if (source === 'rpc_prior_block') return 'approximate';
  if (source === 'tx_receipt_actual' || source === 'tx_receipt_transfers' || source === 'tx_input_estimated') {
    return 'estimated';
  }
  return 'unavailable';
}

function getHistoricalPriceSource(accuracy) {
  if (accuracy === 'exact') return 'rpc_exact';
  if (accuracy === 'approximate') return 'rpc_prior_block';
  return 'unavailable';
}

function getOpeningSourceLabel(source) {
  switch (source) {
    case 'rpc_exact':
      return 'RPC bloque exacto';
    case 'rpc_prior_block':
      return 'RPC bloque previo';
    case 'tx_receipt_actual':
    case 'tx_receipt_transfers':
      return 'Tx de apertura';
    case 'tx_input_estimated':
      return 'Calldata de apertura';
    default:
      return 'No disponible';
  }
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function topicToAddress(topic) {
  if (!topic || typeof topic !== 'string' || topic.length < 42) return null;
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function normalizeTxValue(value) {
  if (value == null) return '0x0';
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value;
    try {
      return ethers.toBeHex(BigInt(value));
    } catch {
      return '0x0';
    }
  }
  try {
    return ethers.toBeHex(BigInt(value));
  } catch {
    return '0x0';
  }
}

function normalizeBlockNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return Number.parseInt(value, 16);
    return Number.parseInt(value, 10);
  }
  return null;
}

function normalizeTransactionShape(tx) {
  if (!tx) return null;
  return {
    ...tx,
    hash: tx.hash || tx.transactionHash || null,
    to: normalizeAddress(tx.to),
    from: normalizeAddress(tx.from),
    data: tx.data || tx.input || '0x',
    value: normalizeTxValue(tx.value),
    blockNumber: normalizeBlockNumber(tx.blockNumber),
  };
}

function normalizeReceiptShape(receipt) {
  if (!receipt) return null;
  return {
    ...receipt,
    transactionHash: receipt.transactionHash || receipt.hash || null,
    blockNumber: normalizeBlockNumber(receipt.blockNumber),
    logs: Array.isArray(receipt.logs) ? receipt.logs : [],
  };
}

function inferSpotPriceFromLpAmounts({
  liquidity,
  amount0,
  amount1,
  tickLower,
  tickUpper,
  token0Decimals,
  token1Decimals,
}) {
  const liquidityFloat = Number(liquidity);
  const amount0Float = Number(amount0);
  const amount1Float = Number(amount1);

  if (
    !Number.isFinite(liquidityFloat) ||
    liquidityFloat <= 0 ||
    !Number.isFinite(amount0Float) ||
    !Number.isFinite(amount1Float) ||
    amount0Float <= 0 ||
    amount1Float <= 0 ||
    tickLower == null ||
    tickUpper == null
  ) {
    return null;
  }

  const sqrtLower = tickToRawSqrtRatio(tickLower);
  const sqrtUpper = tickToRawSqrtRatio(tickUpper);
  if (!Number.isFinite(sqrtLower) || !Number.isFinite(sqrtUpper) || sqrtLower <= 0 || sqrtUpper <= 0) {
    return null;
  }

  const lower = Math.min(sqrtLower, sqrtUpper);
  const upper = Math.max(sqrtLower, sqrtUpper);
  const amount0Raw = amount0Float * (10 ** token0Decimals);
  const amount1Raw = amount1Float * (10 ** token1Decimals);

  if (!Number.isFinite(amount0Raw) || !Number.isFinite(amount1Raw) || amount0Raw <= 0 || amount1Raw <= 0) {
    return null;
  }

  const sqrtFromAmount1 = lower + (amount1Raw / liquidityFloat);
  const sqrtFromAmount0 = (liquidityFloat * upper) / ((amount0Raw * upper) + liquidityFloat);

  if (
    !Number.isFinite(sqrtFromAmount0) ||
    !Number.isFinite(sqrtFromAmount1) ||
    sqrtFromAmount0 <= lower ||
    sqrtFromAmount0 >= upper ||
    sqrtFromAmount1 <= lower ||
    sqrtFromAmount1 >= upper
  ) {
    return null;
  }

  const mean = (sqrtFromAmount0 + sqrtFromAmount1) / 2;
  const relativeDiff = Math.abs(sqrtFromAmount0 - sqrtFromAmount1) / mean;
  if (!Number.isFinite(relativeDiff) || relativeDiff > 0.05) {
    return null;
  }

  return compactNumber((mean ** 2) * (10 ** (token0Decimals - token1Decimals)), 6);
}

function extractOutgoingTokenTransfers({ receipt, tx, walletAddress, token0, token1 }) {
  const normalizedWallet = lower(walletAddress);
  if (!normalizedWallet || !receipt) return null;

  let amount0Raw = 0n;
  let amount1Raw = 0n;

  for (const log of receipt.logs || []) {
    if (lower(log.topics?.[0]) !== lower(TRANSFER_EVENT_TOPIC)) continue;
    const from = topicToAddress(log.topics?.[1]);
    if (lower(from) !== normalizedWallet) continue;
    const logAddress = normalizeAddress(log.address);
    const amountRaw = normalizeTxValue(log.data);

    if (token0?.isNative !== true && logAddress && lower(logAddress) === lower(token0?.address)) {
      amount0Raw += BigInt(amountRaw);
    }
    if (token1?.isNative !== true && logAddress && lower(logAddress) === lower(token1?.address)) {
      amount1Raw += BigInt(amountRaw);
    }
  }

  if (token0?.isNative) amount0Raw += BigInt(normalizeTxValue(tx?.value));
  if (token1?.isNative) amount1Raw += BigInt(normalizeTxValue(tx?.value));

  if (amount0Raw <= 0n && amount1Raw <= 0n) return null;

  return {
    amount0: compactNumber(formatTokenAmount(amount0Raw, token0?.decimals ?? 18), 8),
    amount1: compactNumber(formatTokenAmount(amount1Raw, token1?.decimals ?? 18), 8),
    source: 'tx_receipt_transfers',
  };
}

function decodeV4Plan(unlockData) {
  if (!unlockData || unlockData === '0x') return null;
  try {
    const [actionsRaw, paramsRaw] = V4_PLAN_DECODER.decode(['bytes', 'bytes[]'], unlockData);
    return {
      actions: Array.from(ethers.getBytes(actionsRaw)),
      params: Array.from(paramsRaw || []),
    };
  } catch {
    return null;
  }
}

function decodeV4MintActionParam(param) {
  try {
    const decoded = V4_PLAN_DECODER.decode(V4_MINT_PARAM_TYPES, param);
    return {
      poolKey: decoded[0],
      tickLower: Number(decoded[1]),
      tickUpper: Number(decoded[2]),
      liquidity: normalizeTxValue(decoded[3]),
      amount0Max: normalizeTxValue(decoded[4]),
      amount1Max: normalizeTxValue(decoded[5]),
      owner: normalizeAddress(decoded[6]),
    };
  } catch {
    return null;
  }
}

function extractV4MintInputFromPlan(unlockData, token0, token1) {
  const plan = decodeV4Plan(unlockData);
  if (!plan || plan.actions.length !== plan.params.length) return null;

  for (let index = 0; index < plan.actions.length; index += 1) {
    if (plan.actions[index] !== V4_ACTIONS.MINT_POSITION) continue;
    const mint = decodeV4MintActionParam(plan.params[index]);
    if (!mint) continue;
    if (token0?.address && lower(mint.poolKey?.currency0) !== lower(token0.address)) continue;
    if (token1?.address && lower(mint.poolKey?.currency1) !== lower(token1.address)) continue;
    return {
      amount0: compactNumber(formatTokenAmount(mint.amount0Max, token0?.decimals ?? 18), 8),
      amount1: compactNumber(formatTokenAmount(mint.amount1Max, token1?.decimals ?? 18), 8),
      source: 'tx_input_estimated',
    };
  }

  return null;
}

function extractV3MintInput(tx, networkConfig, token0, token1) {
  const positionManagerAddress = normalizeAddress(networkConfig?.deployments?.v3?.positionManager);
  if (!tx?.data || !positionManagerAddress || lower(tx.to) !== lower(positionManagerAddress)) return null;

  try {
    const iface = new ethers.Interface(V3_MINT_ABI);
    const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });
    if (decoded?.name !== 'mint') return null;
    const params = decoded.args?.params || decoded.args?.[0];
    if (!params) return null;
    if (lower(params.token0) !== lower(token0.address) || lower(params.token1) !== lower(token1.address)) {
      return null;
    }
    return {
      amount0: compactNumber(formatTokenAmount(params.amount0Desired, token0?.decimals ?? 18), 8),
      amount1: compactNumber(formatTokenAmount(params.amount1Desired, token1?.decimals ?? 18), 8),
      source: 'tx_input_estimated',
    };
  } catch {
    return null;
  }
}

function extractV4MintInput(tx, networkConfig, token0, token1) {
  const positionManagerAddress = normalizeAddress(networkConfig?.deployments?.v4?.positionManager);
  const universalRouterAddress = normalizeAddress(getUniversalRouterAddress(networkConfig?.id));
  if (!tx?.data) return null;

  if (positionManagerAddress && lower(tx.to) === lower(positionManagerAddress)) {
    try {
      const iface = new ethers.Interface(V4_POSITION_MANAGER_ABI);
      const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
      if (parsed?.name === 'modifyLiquidities') {
        return extractV4MintInputFromPlan(parsed.args?.[0], token0, token1);
      }
    } catch {
      // noop
    }
  }

  if (universalRouterAddress && lower(tx.to) === lower(universalRouterAddress)) {
    try {
      const iface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
      const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });
      const inputs = Array.from(decoded?.args?.[1] || []);
      for (const input of inputs) {
        const result = extractV4MintInputFromPlan(input, token0, token1);
        if (result) return result;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function extractMintInputAmounts({ tx, networkConfig, version, token0, token1 }) {
  if (!tx || !networkConfig || !version) return null;
  if (version === 'v3') return extractV3MintInput(tx, networkConfig, token0, token1);
  if (version === 'v4') return extractV4MintInput(tx, networkConfig, token0, token1);
  return null;
}

async function fetchEtherscanProxyResult(apiKey, networkConfig, action, params) {
  if (!apiKey || !networkConfig?.chainId) return null;

  try {
    const { data } = await httpClient.get(ETHERSCAN_PROXY_API_URL, {
      params: {
        chainid: networkConfig.chainId,
        module: 'proxy',
        action,
        ...params,
        apikey: apiKey,
      },
      timeout: DEFAULT_TIMEOUT_MS,
    });

    return data?.result ?? null;
  } catch (error) {
    logger.warn('etherscan_proxy_fallback_failed', {
      chainId: networkConfig.chainId,
      action,
      error: error.message,
    });
    return null;
  }
}

async function getTransactionWithFallback(provider, networkConfig, txHash, apiKey = null, fetcher = null) {
  try {
    const tx = fetcher ? await fetcher(txHash) : await provider.getTransaction(txHash);
    return normalizeTransactionShape(tx);
  } catch {
    const tx = await fetchEtherscanProxyResult(apiKey, networkConfig, 'eth_getTransactionByHash', { txhash: txHash });
    return normalizeTransactionShape(tx);
  }
}

async function getReceiptWithFallback(provider, networkConfig, txHash, apiKey = null, fetcher = null) {
  try {
    const receipt = fetcher ? await fetcher(txHash) : await provider.getTransactionReceipt(txHash);
    return normalizeReceiptShape(receipt);
  } catch {
    const receipt = await fetchEtherscanProxyResult(apiKey, networkConfig, 'eth_getTransactionReceipt', { txhash: txHash });
    return normalizeReceiptShape(receipt);
  }
}

async function findV3MintTxFromLogs({ provider, networkConfig, tokenId }) {
  if (!provider || !tokenId) return null;
  const positionManagerAddress = networkConfig?.deployments?.v3?.positionManager;
  if (!positionManagerAddress) return null;
  try {
    const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const zeroTopic = `0x${'0'.repeat(64)}`;
    const latest = await provider.getBlockNumber();
    const step = 10000;
    for (let to = latest; to >= 0; to -= step) {
      const from = Math.max(0, to - step + 1);
      try {
        const logs = await provider.getLogs({
          address: positionManagerAddress,
          topics: [transferTopic, zeroTopic, null, tokenIdHex],
          fromBlock: from,
          toBlock: to,
        });
        if (logs && logs.length > 0) {
          return { txHash: logs[0].transactionHash, blockNumber: logs[0].blockNumber };
        }
      } catch {
        // Algunos RPC limitan el rango. Continuar.
      }
      if (latest - to > 200_000) break;
    }
  } catch (err) {
    logger.warn('find_v3_mint_tx_failed', { tokenId: String(tokenId), error: err.message });
  }
  return null;
}

async function resolveInitialValuation({
  provider,
  networkConfig,
  apiKey = null,
  record,
  positionLiquidity = null,
  token0,
  token1,
  historicalPrice,
  historicalAmounts,
  currentValueUsd,
  unclaimedFeesUsd,
  priceCurrent = null,
  getTransactionByHash,
  getReceiptByHash,
}) {
  const warnings = [];
  const historicalSource = getHistoricalPriceSource(historicalPrice?.accuracy);

  let priceAtOpen = historicalPrice?.price ?? null;
  let priceAtOpenAccuracy = getAccuracyFromSource(historicalSource);
  let priceAtOpenSource = historicalSource;
  let priceAtOpenBlock = historicalSource === 'unavailable'
    ? null
    : historicalPrice?.blockNumber ?? record?.mintBlockNumber ?? null;

  let initialAmounts = historicalAmounts && (historicalAmounts.amount0 != null || historicalAmounts.amount1 != null)
    ? historicalAmounts
    : { amount0: null, amount1: null };
  let initialValueUsd = historicalPrice?.price != null
    ? estimateUsdValueFromPair(
      token0,
      token1,
      initialAmounts.amount0,
      initialAmounts.amount1,
      historicalPrice.price
    )
    : null;
  let initialValueUsdSource = initialValueUsd != null ? historicalSource : 'unavailable';
  let initialValueUsdAccuracy = getAccuracyFromSource(initialValueUsdSource);

  const computeInitialValueUsd = (amount0, amount1, inferredPrice = null) => {
    const preferredPrice = historicalPrice?.price ?? inferredPrice ?? null;
    return estimateUsdValueFromPair(token0, token1, amount0, amount1, preferredPrice);
  };

  let resolvedTxHash = record?.txHash || null;
  if (!resolvedTxHash && record?.identifier && record?.version === 'v3') {
    const discovered = await findV3MintTxFromLogs({
      provider,
      networkConfig,
      tokenId: record.identifier,
    });
    if (discovered) {
      resolvedTxHash = discovered.txHash;
      if (record && !record.txHash) record.txHash = discovered.txHash;
      if (record && !record.mintBlockNumber) record.mintBlockNumber = discovered.blockNumber;
    }
  }

  if ((priceAtOpen == null || initialValueUsd == null || initialAmounts.amount0 == null || initialAmounts.amount1 == null) && resolvedTxHash) {
    const [tx, receipt] = await Promise.all([
      getTransactionWithFallback(provider, networkConfig, resolvedTxHash, apiKey, getTransactionByHash),
      getReceiptWithFallback(provider, networkConfig, resolvedTxHash, apiKey, getReceiptByHash),
    ]);

    const transferAmounts = extractOutgoingTokenTransfers({
      receipt,
      tx,
      walletAddress: record.owner || record.creator,
      token0,
      token1,
    });

    if (transferAmounts) {
      if (initialAmounts.amount0 == null) initialAmounts.amount0 = transferAmounts.amount0;
      if (initialAmounts.amount1 == null) initialAmounts.amount1 = transferAmounts.amount1;

      const transferPrice = inferSpotPriceFromLpAmounts({
        liquidity: positionLiquidity ?? record?.positionLiquidity ?? record?.liquidity,
        amount0: transferAmounts.amount0,
        amount1: transferAmounts.amount1,
        tickLower: record?.tickLower,
        tickUpper: record?.tickUpper,
        token0Decimals: token0?.decimals ?? 18,
        token1Decimals: token1?.decimals ?? 18,
      });
      if (priceAtOpen == null && transferPrice != null) {
        priceAtOpen = transferPrice;
        priceAtOpenAccuracy = getAccuracyFromSource(transferAmounts.source);
        priceAtOpenSource = transferAmounts.source;
        priceAtOpenBlock = tx?.blockNumber ?? receipt?.blockNumber ?? record?.mintBlockNumber ?? null;
      }

      if (initialValueUsd == null) {
        const transferValueUsd = computeInitialValueUsd(
          transferAmounts.amount0,
          transferAmounts.amount1,
          transferPrice
        );
        if (transferValueUsd != null) {
          initialValueUsd = transferValueUsd;
          initialValueUsdSource = transferAmounts.source;
          initialValueUsdAccuracy = getAccuracyFromSource(transferAmounts.source);
        }
      }
    }

    if (initialValueUsd == null || priceAtOpen == null || initialAmounts.amount0 == null || initialAmounts.amount1 == null) {
      const inputAmounts = extractMintInputAmounts({
        tx,
        networkConfig,
        version: record.version,
        token0,
        token1,
      });

      if (inputAmounts) {
        if (initialAmounts.amount0 == null) initialAmounts.amount0 = inputAmounts.amount0;
        if (initialAmounts.amount1 == null) initialAmounts.amount1 = inputAmounts.amount1;

        const inputPrice = inferSpotPriceFromLpAmounts({
          liquidity: positionLiquidity ?? record?.positionLiquidity ?? record?.liquidity,
          amount0: inputAmounts.amount0,
          amount1: inputAmounts.amount1,
          tickLower: record?.tickLower,
          tickUpper: record?.tickUpper,
          token0Decimals: token0?.decimals ?? 18,
          token1Decimals: token1?.decimals ?? 18,
        });
        if (priceAtOpen == null && inputPrice != null) {
          priceAtOpen = inputPrice;
          priceAtOpenAccuracy = getAccuracyFromSource(inputAmounts.source);
          priceAtOpenSource = inputAmounts.source;
          priceAtOpenBlock = tx?.blockNumber ?? receipt?.blockNumber ?? record?.mintBlockNumber ?? null;
        }

        if (initialValueUsd == null) {
          const inputValueUsd = computeInitialValueUsd(
            inputAmounts.amount0,
            inputAmounts.amount1,
            inputPrice
          );
          if (inputValueUsd != null) {
            initialValueUsd = inputValueUsd;
            initialValueUsdSource = inputAmounts.source;
            initialValueUsdAccuracy = getAccuracyFromSource(inputAmounts.source);
          }
        }
      }
    }
  }

  if (
    initialValueUsd == null
    && (initialAmounts.amount0 != null || initialAmounts.amount1 != null)
    && Number.isFinite(Number(priceCurrent))
    && Number(priceCurrent) > 0
  ) {
    const approxValueUsd = estimateUsdValueFromPair(
      token0,
      token1,
      initialAmounts.amount0 || 0,
      initialAmounts.amount1 || 0,
      priceCurrent,
    );
    if (approxValueUsd != null) {
      initialValueUsd = approxValueUsd;
      initialValueUsdSource = 'current_price_fallback';
      initialValueUsdAccuracy = 'approximate';
      warnings.push('El valor inicial se aproximo usando el precio actual del pool (no se pudo reconstruir el precio historico).');
    }
  }

  if (priceAtOpenSource === 'rpc_prior_block') {
    warnings.push('El precio de apertura usa el bloque histórico anterior mas cercano disponible del RPC.');
  }
  if (priceAtOpenSource === 'tx_receipt_transfers') {
    warnings.push('El precio de apertura se reconstruyo desde las transferencias del tx de apertura.');
  }
  if (priceAtOpenSource === 'tx_input_estimated') {
    warnings.push('El precio de apertura se estimo desde el calldata del tx de apertura.');
  }
  if (priceAtOpen == null) {
    priceAtOpenAccuracy = 'unavailable';
    priceAtOpenSource = 'unavailable';
    warnings.push('No se pudo reconstruir el precio al abrir; el P&L total puede no estar disponible.');
  }

  if (initialValueUsdSource === 'rpc_prior_block') {
    warnings.push('El valor inicial usa el bloque histórico anterior mas cercano disponible del RPC.');
  }
  if (initialValueUsdSource === 'tx_receipt_transfers') {
    warnings.push('El valor inicial se reconstruyo desde las transferencias del tx de apertura.');
  }
  if (initialValueUsdSource === 'tx_input_estimated') {
    warnings.push('El valor inicial se estimo desde los montos declarados en el calldata del tx de apertura.');
  }
  if (initialValueUsd == null) {
    initialValueUsdAccuracy = 'unavailable';
    initialValueUsdSource = 'unavailable';
  }
  if (initialValueUsd != null && priceAtOpen == null) {
    warnings.push('Se pudo reconstruir el valor inicial, pero no el precio exacto de apertura para la grafica.');
  }

  let valuationAccuracy = initialValueUsdAccuracy;
  if (currentValueUsd == null || unclaimedFeesUsd == null) {
    valuationAccuracy = valuationAccuracy === 'exact' ? 'approximate' : valuationAccuracy;
    warnings.push('La valuación USD usa una heurística best-effort según el par del LP.');
  }
  if (initialValueUsd == null) {
    valuationAccuracy = 'unavailable';
  }

  return {
    priceAtOpen,
    priceAtOpenAccuracy,
    priceAtOpenSource,
    priceAtOpenBlock,
    initialAmount0: initialAmounts.amount0,
    initialAmount1: initialAmounts.amount1,
    initialValueUsd,
    initialValueUsdAccuracy,
    initialValueUsdSource,
    valuationAccuracy,
    valuationWarnings: buildWarningsWithDedup(warnings),
  };
}

function decodeSigned24(value) {
  const masked = Number(BigInt(value) & 0xFFFFFFn);
  return (masked & 0x800000) !== 0 ? masked - 0x1000000 : masked;
}

function decodeV4PositionInfo(info) {
  const packed = BigInt(info);
  return {
    hasSubscriber: Boolean(packed & 0xFFn),
    tickLower: decodeSigned24(packed >> 8n),
    tickUpper: decodeSigned24(packed >> 32n),
  };
}

async function resolveHistoricalSpotPrice({ blockNumber, fetchAtBlock }) {
  const baseBlock = Number(blockNumber);
  if (!Number.isFinite(baseBlock) || baseBlock <= 0) {
    return {
      price: null,
      tick: null,
      sqrtPriceX96: null,
      blockNumber: null,
      accuracy: 'unavailable',
    };
  }

  for (const offset of HISTORICAL_PRICE_BLOCK_OFFSETS) {
    const targetBlock = baseBlock + offset;
    if (!Number.isFinite(targetBlock) || targetBlock <= 0) continue;
    try {
      const value = await fetchAtBlock(targetBlock);
      if (value && Number.isFinite(Number(value.tick)) && Number.isFinite(Number(value.price))) {
        return {
          price: compactNumber(value.price, 6),
          tick: Number(value.tick),
          sqrtPriceX96: value.sqrtPriceX96 != null ? String(value.sqrtPriceX96) : null,
          blockNumber: targetBlock,
          accuracy: offset === 0 ? 'exact' : 'approximate',
        };
      }
    } catch {
      // Intentamos el siguiente checkpoint si el nodo no tiene estado histórico.
    }
  }

  return {
    price: null,
    tick: null,
    sqrtPriceX96: null,
    blockNumber: null,
    accuracy: 'unavailable',
  };
}

function computeRangeVisual(rangeLowerPrice, rangeUpperPrice, priceAtOpen, priceCurrent) {
  const lower = Number(rangeLowerPrice);
  const upper = Number(rangeUpperPrice);
  const open = Number(priceAtOpen);
  const current = Number(priceCurrent);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower === upper) {
    return {
      currentOutOfRangeSide: null,
    };
  }

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const side =
    Number.isFinite(current) && current < min
      ? 'below'
      : Number.isFinite(current) && current > max
        ? 'above'
        : null;

  return {
    currentOutOfRangeSide: side,
    openMarkerPct: Number.isFinite(open)
      ? Math.max(0, Math.min(100, ((open - min) / (max - min)) * 100))
      : null,
    currentMarkerPct: Number.isFinite(current)
      ? Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100))
      : null,
  };
}

function buildLpMeta(record, scannedAt = Date.now()) {
  const openedAt = Number(record.openedAt || record.createdAt || 0) || null;
  return {
    openedAt,
    activeForMs: openedAt ? Math.max(0, scannedAt - (openedAt * 1000)) : null,
  };
}

function getExplorerLink(baseUrl, kind, value) {
  if (!baseUrl || !value) return null;
  if (kind === 'tx') return `${baseUrl}/tx/${value}`;
  if (kind === 'address') return `${baseUrl}/address/${value}`;
  return null;
}

module.exports = {
  normalizeAddress,
  lower,
  formatTokenAmount,
  buildLiquiditySummary,
  buildWarningsWithDedup,
  getAccuracyFromSource,
  getHistoricalPriceSource,
  getOpeningSourceLabel,
  toNumberOrNull,
  normalizeTransactionShape,
  normalizeReceiptShape,
  inferSpotPriceFromLpAmounts,
  extractMintInputAmounts,
  resolveInitialValuation,
  decodeV4PositionInfo,
  resolveHistoricalSpotPrice,
  computeRangeVisual,
  buildLpMeta,
  getExplorerLink,
};
