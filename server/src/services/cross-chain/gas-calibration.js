/**
 * Calibración del oráculo de comisiones con lo que las txs costaron de verdad.
 *
 * Cada recibo observado deja gas usado, precio efectivo y (en OP Stack) la
 * tarifa de datos L1. El oráculo usa el p95 por red y tipo como respaldo
 * cuando no puede estimar una tx, en vez de la tabla fija.
 */

const defaultRepository = require('../../repositories/gas-observation.repository');
const logger = require('../logger.service');

const CACHE_TTL_MS = 10 * 60_000;

// Solo los tipos que se reconocen sin ambigüedad por el selector.
const SELECTOR_KINDS = {
  '0x095ea7b3': 'approval',
  '0x87517c45': 'permit2_approval',
  '0xd0e30db0': 'wrap_native',
  '0x2e1a7d4d': 'unwrap_native',
};

function classifyTxInput(input) {
  if (!input) return null;
  return SELECTOR_KINDS[String(input).slice(0, 10).toLowerCase()] || null;
}

function toDecimalString(value) {
  return value == null ? null : BigInt(value).toString();
}

function createGasCalibration({ repository = defaultRepository, now = Date.now } = {}) {
  const cache = new Map();

  async function getCalibratedGasUnits({ network, kind }) {
    const key = `${network}:${kind}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await repository.getP95GasUsed({ network, kind }).catch((err) => {
      logger.warn('gas_calibration_read_failed', { network, kind, error: err?.message });
      return null;
    });
    cache.set(key, { at: now(), value });
    return value;
  }

  /**
   * Lee el recibo crudo (ethers no expone `l1Fee` de OP) y, si la tx salió
   * bien, lo guarda. Devuelve el resultado aunque haya revertido: el monitor
   * lo usa para decidir el estado del paso.
   */
  async function observeReceipt({
    network,
    provider,
    txHash,
    kind = null,
    profile = null,
    estimatedGas = null,
    submittedBlock = null,
  }) {
    const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
    if (!receipt) return null;

    let resolvedKind = kind;
    if (!resolvedKind) {
      const tx = await provider.send('eth_getTransactionByHash', [txHash]);
      resolvedKind = classifyTxInput(tx?.input);
    }

    const blockNumber = Number(BigInt(receipt.blockNumber));
    const observation = {
      network,
      kind: resolvedKind,
      profile,
      estimatedGas: toDecimalString(estimatedGas),
      gasUsed: toDecimalString(receipt.gasUsed),
      effectiveGasPriceWei: toDecimalString(receipt.effectiveGasPrice || 0),
      l1FeeWei: toDecimalString(receipt.l1Fee),
      waitBlocks: submittedBlock != null ? blockNumber - Number(submittedBlock) : null,
      txHash,
      blockNumber,
      status: receipt.status === '0x1' ? 'success' : 'reverted',
    };

    if (observation.status === 'success' && resolvedKind) {
      await repository.insert({ ...observation, createdAt: now() }).catch((err) => {
        logger.warn('gas_observation_insert_failed', { network, txHash, error: err?.message });
      });
    }
    return observation;
  }

  async function observeTxHashes({ network, provider, txHashes = [] }) {
    for (const txHash of txHashes) {
      try {
        await observeReceipt({ network, provider, txHash });
      } catch (err) {
        logger.warn('gas_observation_failed', { network, txHash, error: err?.message });
      }
    }
  }

  return { getCalibratedGasUnits, observeReceipt, observeTxHashes, classifyTxInput };
}

module.exports = createGasCalibration();
module.exports.createGasCalibration = createGasCalibration;
module.exports.classifyTxInput = classifyTxInput;
