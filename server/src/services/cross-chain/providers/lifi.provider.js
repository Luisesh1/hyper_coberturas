/**
 * Proveedor Li.Fi (agregador): cotiza la mejor ruta entre sus bridges y
 * devuelve la tx lista para firmar. Su comisión fija (0,25 %) viene en
 * `feeCosts`; el planificador la compara contra Across directo.
 */

const { getNetworkConfig } = require('../../uniswap/networks');
const { assertAllowedTarget } = require('../bridge-allowlist');
const { buildApprovalTx } = require('./approval');
const { getJson, quoteFailed } = require('./http');
const { assertMinOut } = require('./quote-guards');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isNativeToken(address) {
  return String(address || '').toLowerCase() === ZERO_ADDRESS;
}

function toDecimal(value) {
  return value == null ? null : BigInt(value).toString();
}

function createLifiProvider({
  fetchImpl = (...args) => global.fetch(...args),
  apiKey = process.env.LIFI_API_KEY || null,
  baseUrl = process.env.LIFI_API_URL || 'https://li.quest/v1',
} = {}) {
  const headers = apiKey ? { 'x-lifi-api-key': apiKey } : {};

  async function quote({ fromNetwork, toNetwork, fromToken, toToken, fromAmountRaw, walletAddress, slippageBps }) {
    const params = new URLSearchParams({
      fromChain: String(getNetworkConfig(fromNetwork).chainId),
      toChain: String(getNetworkConfig(toNetwork).chainId),
      fromToken,
      toToken,
      fromAmount: String(fromAmountRaw),
      fromAddress: walletAddress,
      toAddress: walletAddress,
      slippage: String(Number(slippageBps) / 10_000),
    });
    const response = await getJson(fetchImpl, `${baseUrl}/quote?${params}`, { headers, provider: 'Li.Fi' });
    if (!response.ok || !response.body?.transactionRequest) throw quoteFailed('Li.Fi', response);

    const { transactionRequest: request, estimate = {}, tool } = response.body;
    assertAllowedTarget({ provider: 'lifi', network: fromNetwork, to: request.to });

    assertMinOut({ provider: 'Li.Fi', toAmountRaw: estimate.toAmount, toAmountMinRaw: estimate.toAmountMin, slippageBps });

    let approvalTxs = [];
    if (!isNativeToken(fromToken)) {
      assertAllowedTarget({ provider: 'lifi', network: fromNetwork, to: estimate.approvalAddress, role: 'spender' });
      approvalTxs = [buildApprovalTx({ token: fromToken, spender: estimate.approvalAddress, amountRaw: fromAmountRaw })];
    }

    return {
      provider: 'lifi',
      tool: tool || null,
      fromNetwork,
      toNetwork,
      fromToken,
      toToken,
      fromAmountRaw: String(fromAmountRaw),
      toAmountRaw: toDecimal(estimate.toAmount),
      toAmountMinRaw: toDecimal(estimate.toAmountMin),
      feeCosts: (estimate.feeCosts || []).map((fee) => ({
        name: fee.name,
        amountUsd: Number(fee.amountUSD) || 0,
        included: fee.included !== false,
      })),
      approvalTxs,
      tx: {
        to: request.to,
        data: request.data,
        value: toDecimal(request.value || 0),
        chainId: Number(request.chainId),
        gasLimit: toDecimal(request.gasLimit),
      },
      etaSec: Number(estimate.executionDuration) || null,
      expiresAt: null,
      ref: { tool: tool || null },
    };
  }

  async function status({ txHash, fromNetwork, toNetwork, ref = {} }) {
    const params = new URLSearchParams({
      txHash,
      fromChain: String(getNetworkConfig(fromNetwork).chainId),
      toChain: String(getNetworkConfig(toNetwork).chainId),
    });
    if (ref.tool) params.set('bridge', ref.tool);
    const response = await getJson(fetchImpl, `${baseUrl}/status?${params}`, { headers, provider: 'Li.Fi' });
    const body = response.body || {};
    if (body.status === 'DONE') {
      if (body.substatus === 'REFUNDED') return { status: 'refunded', receivedRaw: null, message: body.substatusMessage || null };
      return { status: 'delivered', receivedRaw: toDecimal(body.receiving?.amount), message: body.substatusMessage || null };
    }
    if (body.status === 'FAILED' || body.status === 'INVALID') {
      return { status: 'failed', receivedRaw: null, message: body.substatusMessage || body.message || null };
    }
    return { status: 'pending', receivedRaw: null, message: null };
  }

  return { id: 'lifi', quote, status };
}

module.exports = createLifiProvider();
module.exports.createLifiProvider = createLifiProvider;
module.exports.ZERO_ADDRESS = ZERO_ADDRESS;
module.exports.isNativeToken = isNativeToken;
