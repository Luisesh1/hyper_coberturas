/**
 * Proveedor Across directo (API de swap/approval). Sirve de comparador de la
 * ruta de Li.Fi: el mismo bridge sin la comisión fija del agregador.
 */

const { getNetworkConfig } = require('../../uniswap/networks');
const { assertAllowedTarget } = require('../bridge-allowlist');
const { decodeApproval } = require('./approval');
const { getJson, quoteFailed } = require('./http');

function toDecimal(value) {
  return value == null ? null : BigInt(value).toString();
}

// Solo los conceptos con importe: un «LP fee 0» no aporta nada al desglose.
function mapFees(details = {}) {
  const bridge = details.bridge?.details || {};
  const entries = [
    ['Comisión de LP (Across)', bridge.lp],
    ['Relayer (Across)', bridge.relayerCapital],
    ['Gas en destino (Across)', bridge.destinationGas],
    ['Comisión de app', details.app],
    ['Impacto del swap', details.swapImpact],
  ];
  return entries
    .map(([name, fee]) => ({ name, amountUsd: Number(fee?.amountUsd) || 0, included: true }))
    .filter((fee) => Math.abs(fee.amountUsd) >= 0.0001);
}

function createAcrossProvider({
  fetchImpl = (...args) => global.fetch(...args),
  baseUrl = process.env.ACROSS_API_URL || 'https://app.across.to/api',
} = {}) {
  async function quote({ fromNetwork, toNetwork, fromToken, toToken, fromAmountRaw, walletAddress, slippageBps }) {
    const params = new URLSearchParams({
      tradeType: 'exactInput',
      amount: String(fromAmountRaw),
      inputToken: fromToken,
      outputToken: toToken,
      originChainId: String(getNetworkConfig(fromNetwork).chainId),
      destinationChainId: String(getNetworkConfig(toNetwork).chainId),
      depositor: walletAddress,
      recipient: walletAddress,
      slippage: String(Number(slippageBps) / 10_000),
    });
    const response = await getJson(fetchImpl, `${baseUrl}/swap/approval?${params}`, { provider: 'Across' });
    if (!response.ok || !response.body?.swapTx) throw quoteFailed('Across', response);

    const body = response.body;
    assertAllowedTarget({ provider: 'across', network: fromNetwork, to: body.swapTx.to });

    const approvalTxs = (body.approvalTxns || []).map((approval) => {
      const decoded = decodeApproval(approval.data);
      if (!decoded) {
        assertAllowedTarget({ provider: 'across', network: fromNetwork, to: approval.to, role: 'approval' });
      }
      assertAllowedTarget({ provider: 'across', network: fromNetwork, to: decoded.spender, role: 'spender' });
      return { to: approval.to, data: approval.data, value: '0', spender: decoded.spender };
    });

    const gas = body.swapTx.gas && BigInt(body.swapTx.gas) > 0n ? toDecimal(body.swapTx.gas) : null;
    return {
      provider: 'across',
      tool: 'across',
      fromNetwork,
      toNetwork,
      fromToken,
      toToken,
      fromAmountRaw: String(fromAmountRaw),
      toAmountRaw: toDecimal(body.expectedOutputAmount),
      toAmountMinRaw: toDecimal(body.minOutputAmount),
      feeCosts: mapFees(body.fees?.total?.details),
      approvalTxs,
      tx: {
        to: body.swapTx.to,
        data: body.swapTx.data,
        value: toDecimal(body.swapTx.value || 0),
        chainId: Number(body.swapTx.chainId),
        gasLimit: gas,
      },
      etaSec: Number(body.expectedFillTime) || null,
      expiresAt: body.quoteExpiryTimestamp ? Number(body.quoteExpiryTimestamp) * 1000 : null,
      ref: { quoteId: body.id || null },
    };
  }

  async function status({ txHash, fromNetwork }) {
    const params = new URLSearchParams({
      originChainId: String(getNetworkConfig(fromNetwork).chainId),
      depositTxHash: txHash,
    });
    const response = await getJson(fetchImpl, `${baseUrl}/deposit/status?${params}`, { provider: 'Across' });
    const body = response.body || {};
    // Across no informa el monto entregado: el monitor usa el esperado de la cotización.
    if (body.status === 'filled') return { status: 'delivered', receivedRaw: null, message: null };
    if (body.status === 'refunded') return { status: 'refunded', receivedRaw: null, message: null };
    if (body.status === 'expired') {
      return { status: 'failed', receivedRaw: null, message: 'El depósito expiró sin relayer; Across lo reembolsa en la red de origen.' };
    }
    return { status: 'pending', receivedRaw: null, message: null };
  }

  return { id: 'across', quote, status };
}

module.exports = createAcrossProvider();
module.exports.createAcrossProvider = createAcrossProvider;
