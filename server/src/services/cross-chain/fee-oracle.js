/**
 * Oráculo de comisiones: cuánto cuesta cada tx de un plan, por red y perfil.
 *
 * Precio del gas: `eth_feeHistory` (20 bloques, p10/p50/p90) pasado por los
 * perfiles de `fee-profiles`. Gas units, en este orden: `estimateGas` de la tx
 * real, el `gasLimit` que da el proveedor del bridge (cuando la tx depende de
 * un approve que aún no existe), el p95 calibrado con recibos reales y, por
 * último, la tabla fija del estimador.
 *
 * L1: en OP Stack la tarifa de datos L1 se cobra aparte y se suma; en Orbit
 * `estimateGas` ya incluye las unidades de L1, así que solo se informa.
 */

const { ethers } = require('ethers');
const onChainManager = require('../onchain-manager.service');
const logger = require('../logger.service');
const { getNetworkConfig } = require('../uniswap/networks');
const { GAS_PER_TX_TYPE, DEFAULT_GAS_PER_UNKNOWN_TX } = require('../uniswap/gas-cost-estimator');
const gasCalibration = require('./gas-calibration');
const {
  PROFILE_IDS,
  FEE_HISTORY_BLOCKS,
  FEE_HISTORY_PERCENTILES,
  computeProfileFees,
  applyGasLimitBuffer,
  getChainFamily,
} = require('./fee-profiles');

const FEE_HISTORY_TTL_MS = 15_000;
const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const ARB_NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
const OP_IFACE = new ethers.Interface([
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
]);
const NODE_IFACE = new ethers.Interface([
  'function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
]);

// Tamaño aproximado del calldata por tipo, para la cota de L1 en OP cuando la
// tx todavía no existe (las del LP en la red destino se arman en la fase 2).
const TABLE_CALLDATA_BYTES = {
  approval: 68,
  permit2_approval: 132,
  swap: 600,
  mint_position: 900,
  mint_position_v4: 1300,
  bridge: 900,
  wrap_native: 4,
  unwrap_native: 36,
};
// Envoltorio aproximado de una tx tipo 2 (firma, nonce, fees, destino).
const TX_ENVELOPE_BYTES = 68;
const OP_L1_MAX_MARGIN_NUM = 12n;
const OP_L1_MAX_MARGIN_DEN = 10n;

/**
 * `onChainManager.getProvider` devuelve un FallbackProvider cuando la red tiene
 * varios RPC, y ese no expone `send`. Para los métodos crudos se prueban sus
 * RPC en orden: si el principal no sirve la red (p. ej. una app de Alchemy
 * sin Robinhood habilitada), responde el de respaldo.
 */
function rpcSender(provider) {
  if (provider && typeof provider.send === 'function') return provider;
  const inners = (provider?.providerConfigs || [])
    .map((config) => config?.provider)
    .filter((inner) => inner && typeof inner.send === 'function');
  if (!inners.length) throw new Error('El provider no permite llamadas JSON-RPC crudas');
  return {
    async send(method, params) {
      let firstError = null;
      for (const inner of inners) {
        try {
          return await inner.send(method, params);
        } catch (err) {
          firstError = firstError || err;
        }
      }
      throw firstError;
    },
  };
}

function defaultGetProvider(network) {
  return onChainManager.getProvider(getNetworkConfig(network), { scope: 'cross-chain' });
}

function weiToUsd(wei, nativeUsdPrice) {
  if (nativeUsdPrice == null || !Number.isFinite(Number(nativeUsdPrice))) return null;
  return Number(ethers.formatEther(BigInt(wei))) * Number(nativeUsdPrice);
}

function createFeeOracle({
  getProvider = defaultGetProvider,
  getCalibratedGasUnits = (args) => gasCalibration.getCalibratedGasUnits(args),
  now = Date.now,
} = {}) {
  const historyCache = new Map();

  async function getFeeHistory(network) {
    const hit = historyCache.get(network);
    if (hit && now() - hit.at < FEE_HISTORY_TTL_MS) return hit.value;
    const value = await rpcSender(getProvider(network)).send('eth_feeHistory', [
      ethers.toQuantity(FEE_HISTORY_BLOCKS),
      'latest',
      FEE_HISTORY_PERCENTILES,
    ]);
    historyCache.set(network, { at: now(), value });
    return value;
  }

  async function getProfileFees({ network, profile }) {
    return computeProfileFees({ network, profile, feeHistory: await getFeeHistory(network) });
  }

  async function resolveGasUnits({ provider, network, tx, from }) {
    if (tx.to && tx.data && from) {
      try {
        const estimated = await provider.estimateGas({
          from,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value || 0),
        });
        return { gasUnits: BigInt(estimated), source: 'estimated' };
      } catch {
        // Lo normal: el bridge depende de un approve que todavía no existe.
      }
    }
    if (tx.providerGasLimit) return { gasUnits: BigInt(tx.providerGasLimit), source: 'provider' };
    const calibrated = await getCalibratedGasUnits({ network, kind: tx.kind }).catch(() => null);
    if (calibrated) return { gasUnits: BigInt(calibrated), source: 'calibrated' };
    return { gasUnits: BigInt(GAS_PER_TX_TYPE[tx.kind] || DEFAULT_GAS_PER_UNKNOWN_TX), source: 'table' };
  }

  async function estimateL1({ provider, network, tx, chainId }) {
    const family = getChainFamily(network);
    try {
      if (family === 'op') {
        if (tx.to && tx.data) {
          const unsigned = ethers.Transaction.from({
            type: 2,
            chainId,
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value || 0),
            nonce: 0,
            gasLimit: 0,
            maxFeePerGas: 0,
            maxPriorityFeePerGas: 0,
          }).unsignedSerialized;
          const out = await provider.call({
            to: OP_GAS_PRICE_ORACLE,
            data: OP_IFACE.encodeFunctionData('getL1Fee', [unsigned]),
          });
          return { l1FeeWei: OP_IFACE.decodeFunctionResult('getL1Fee', out)[0], l1Mode: 'additive' };
        }
        const size = (TABLE_CALLDATA_BYTES[tx.kind] || 500) + TX_ENVELOPE_BYTES;
        const out = await provider.call({
          to: OP_GAS_PRICE_ORACLE,
          data: OP_IFACE.encodeFunctionData('getL1FeeUpperBound', [size]),
        });
        return { l1FeeWei: OP_IFACE.decodeFunctionResult('getL1FeeUpperBound', out)[0], l1Mode: 'additive' };
      }
      if (family === 'orbit' && tx.to && tx.data) {
        const out = await provider.call({
          to: ARB_NODE_INTERFACE,
          data: NODE_IFACE.encodeFunctionData('gasEstimateL1Component', [tx.to, false, tx.data]),
        });
        const [gasForL1, baseFee] = NODE_IFACE.decodeFunctionResult('gasEstimateL1Component', out);
        return { l1FeeWei: BigInt(gasForL1) * BigInt(baseFee), l1Mode: 'included' };
      }
    } catch (err) {
      logger.warn('fee_oracle_l1_fee_failed', { network, kind: tx.kind, error: err?.message });
      return { l1FeeWei: 0n, l1Mode: family === 'op' ? 'unknown' : (family === 'orbit' ? 'included' : 'none') };
    }
    return { l1FeeWei: 0n, l1Mode: family === 'orbit' ? 'included' : 'none' };
  }

  /**
   * @param {{ network: string, profile: string, txs: Array<{kind: string, label?: string,
   *   to?: string, data?: string, value?: string, providerGasLimit?: string}>,
   *   from?: string|null, nativeUsdPrice?: number|null }} args
   */
  async function estimateTxCosts({ network, profile, txs, from = null, nativeUsdPrice = null }) {
    const networkConfig = getNetworkConfig(network);
    const provider = getProvider(network);
    const fees = await getProfileFees({ network, profile });

    const items = [];
    for (const tx of txs || []) {
      const { gasUnits, source } = await resolveGasUnits({ provider, network, tx, from });
      const { l1FeeWei, l1Mode } = await estimateL1({ provider, network, tx, chainId: networkConfig.chainId });
      const additiveL1 = l1Mode === 'additive' ? BigInt(l1FeeWei) : 0n;
      const gasLimit = applyGasLimitBuffer(gasUnits, profile);
      const expectedWei = gasUnits * fees.expectedGasPriceWei + additiveL1;
      const maxWei = gasLimit * fees.maxFeePerGas + (additiveL1 * OP_L1_MAX_MARGIN_NUM) / OP_L1_MAX_MARGIN_DEN;
      items.push({
        kind: tx.kind,
        label: tx.label || tx.kind,
        gasUnits: gasUnits.toString(),
        gasLimit: gasLimit.toString(),
        source,
        l1FeeWei: BigInt(l1FeeWei).toString(),
        l1Mode,
        expectedWei: expectedWei.toString(),
        maxWei: maxWei.toString(),
        expectedUsd: weiToUsd(expectedWei, nativeUsdPrice),
        maxUsd: weiToUsd(maxWei, nativeUsdPrice),
        l1Usd: weiToUsd(l1FeeWei, nativeUsdPrice),
      });
    }

    const totalExpectedWei = items.reduce((acc, item) => acc + BigInt(item.expectedWei), 0n);
    const totalMaxWei = items.reduce((acc, item) => acc + BigInt(item.maxWei), 0n);
    return {
      network,
      profile,
      family: fees.family,
      // En Orbit la priority fee no compra nada: los perfiles solo mueven topes.
      profilesMatter: fees.family !== 'orbit',
      fees: {
        baseFeeNextWei: fees.baseFeeNextWei.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
      txs: items,
      totalExpectedWei: totalExpectedWei.toString(),
      totalMaxWei: totalMaxWei.toString(),
      totalExpectedUsd: weiToUsd(totalExpectedWei, nativeUsdPrice),
      totalMaxUsd: weiToUsd(totalMaxWei, nativeUsdPrice),
    };
  }

  async function compareProfiles(args) {
    const entries = await Promise.all(
      PROFILE_IDS.map(async (profile) => [profile, await estimateTxCosts({ ...args, profile })])
    );
    return Object.fromEntries(entries);
  }

  function clearCache() {
    historyCache.clear();
  }

  return { getFeeHistory, getProfileFees, estimateTxCosts, compareProfiles, clearCache };
}

module.exports = createFeeOracle();
module.exports.createFeeOracle = createFeeOracle;
module.exports.rpcSender = rpcSender;
module.exports.weiToUsd = weiToUsd;
