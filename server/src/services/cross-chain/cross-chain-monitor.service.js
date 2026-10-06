/**
 * Vigila los envíos cross-chain en vuelo.
 *
 * `signed` → mira el recibo en la red de origen (gas real, calibración, si la
 * wallet ignoró las fees del perfil). `source_confirmed` → pregunta al
 * proveedor si llegó, se reembolsó o falló. Mismo patrón que el monitor del
 * orquestador: start/stop, sin solapes, un paso con error no frena a los demás.
 */

const { ethers } = require('ethers');
const logger = require('../logger.service');
const marketService = require('../market.service');
const onChainManager = require('../onchain-manager.service');
const { getNetworkConfig } = require('../uniswap/networks');
const defaultRepo = require('../../repositories/cross-chain-plan.repository');
const defaultCalibration = require('./gas-calibration');
const { rpcSender } = require('./fee-oracle');
const { rawToUsd } = require('./bridge-planner');
const { usdPriceForSymbol } = require('./pricing');
const lifiProvider = require('./providers/lifi.provider');
const acrossProvider = require('./providers/across.provider');

const config = require('../../config');

class CrossChainMonitorService {
  constructor(deps = {}) {
    this.repo = deps.repo || defaultRepo;
    this.providers = deps.providers || { lifi: lifiProvider, across: acrossProvider };
    this.calibration = deps.calibration || defaultCalibration;
    this.getRpc = deps.getRpc || ((network) => rpcSender(onChainManager.getProvider(getNetworkConfig(network), { scope: 'cross-chain' })));
    this.getPrices = deps.getPrices || (() => marketService.getAllPrices());
    this.logger = deps.logger || logger;
    this.intervalMs = deps.intervalMs || config.crossChainFunding.monitorIntervalMs;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.tick().catch((err) => this.logger.error('cross_chain_monitor_unhandled_error', { error: err.message }));
    }, this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const steps = await this.repo.listInFlightSteps();
      if (!steps.length) return;
      const prices = await this.getPrices().catch(() => ({}));
      for (const step of steps) {
        try {
          const changed = step.status === 'signed'
            ? await this.checkSource(step, prices)
            : await this.checkDelivery(step);
          if (changed) await this.repo.recomputePlanStatus(step.planId);
        } catch (err) {
          this.logger.warn('cross_chain_monitor_step_failed', {
            planId: step.planId, order: step.order, status: step.status, error: err?.message,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async checkSource(step, prices) {
    const rpc = this.getRpc(step.sourceNetwork);
    if (step.approvalTxHash) {
      this.calibration.observeReceipt({
        network: step.sourceNetwork, provider: rpc, txHash: step.approvalTxHash, kind: 'approval', profile: step.sentFees?.profile || null,
      }).catch(() => {});
    }
    const observation = await this.calibration.observeReceipt({
      network: step.sourceNetwork,
      provider: rpc,
      txHash: step.txHash,
      kind: 'bridge',
      profile: step.sentFees?.profile || null,
      estimatedGas: step.sentFees?.gasLimit || null,
    });
    if (!observation) return false;
    if (observation.status !== 'success') {
      await this.repo.updateStep(step.planId, step.order, {
        status: 'failed',
        errorMessage: 'La transacción revirtió en la red de origen: los fondos no salieron.',
      });
      return true;
    }
    const gasWei = BigInt(observation.gasUsed) * BigInt(observation.effectiveGasPriceWei) + BigInt(observation.l1FeeWei || 0);
    const nativePrice = usdPriceForSymbol(getNetworkConfig(step.sourceNetwork).nativeSymbol, prices);
    const maxFee = step.sentFees?.maxFeePerGas != null ? BigInt(step.sentFees.maxFeePerGas) : null;
    await this.repo.updateStep(step.planId, step.order, {
      status: 'source_confirmed',
      realCostUsd: nativePrice != null ? Number(ethers.formatEther(gasWei)) * nativePrice : null,
      walletOverrodeFees: maxFee != null && BigInt(observation.effectiveGasPriceWei) > maxFee,
    });
    return true;
  }

  async checkDelivery(step) {
    const provider = this.providers[step.provider];
    const result = await provider.status({
      txHash: step.txHash,
      fromNetwork: step.sourceNetwork,
      toNetwork: step.destinationNetwork,
      ref: step.quote?.quote?.ref || {},
    });
    if (result.status === 'delivered') {
      const receivedRaw = result.receivedRaw || step.quote?.quote?.toAmountRaw || null;
      const delivery = step.quote?.deliveryToken || {};
      const receivedUsd = receivedRaw != null ? rawToUsd(receivedRaw, delivery.decimals ?? 18, delivery.priceUsd ?? null) : null;
      const bridgeLossUsd = receivedUsd != null && step.quote?.amountUsd != null
        ? Math.max(0, step.quote.amountUsd - receivedUsd)
        : 0;
      await this.repo.updateStep(step.planId, step.order, {
        status: 'delivered',
        receivedRaw,
        realCostUsd: (step.realCostUsd || 0) + bridgeLossUsd,
      });
      return true;
    }
    if (result.status === 'refunded' || result.status === 'failed') {
      await this.repo.updateStep(step.planId, step.order, {
        status: result.status,
        errorMessage: result.message || (result.status === 'refunded'
          ? 'El bridge devolvió los fondos a la red de origen.'
          : 'El bridge no completó el envío.'),
      });
      return true;
    }
    return false;
  }
}

module.exports = new CrossChainMonitorService();
module.exports.CrossChainMonitorService = CrossChainMonitorService;
