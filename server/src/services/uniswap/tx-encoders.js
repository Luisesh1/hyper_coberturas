/**
 * Constructores de transacciones serializables para acciones sobre tokens y pools.
 * Centraliza la creación de approvals, wraps/unwraps y la serialización genérica
 * de transacciones (`encodeTx`).
 *
 * Extraído de `uniswap-position-actions.service.js` para reducir su tamaño.
 */

const { ethers } = require('ethers');
const { ERC20_ABI, WRAPPED_NATIVE_ABI } = require('./abis');
const { MAX_UINT256, DEFAULT_DEADLINE_SECONDS } = require('./constants');

/**
 * Construye una transacción serializable para el cliente.
 *
 * @param {string} to - Dirección destino del contrato.
 * @param {string} data - Calldata hex.
 * @param {object} [options]
 * @param {string} [options.value='0x0']
 * @param {number} [options.chainId]
 * @param {string} [options.label]
 * @param {string} [options.kind]
 * @param {number|null} [options.sequence]
 * @param {string} [options.gas]
 * @param {object} [options.meta]
 */
function encodeTx(to, data, { value = '0x0', chainId, label, kind, sequence, gas, meta = {} } = {}) {
  const tx = {
    to,
    data,
    value,
    chainId,
    label: label || kind || 'transaction',
    kind: kind || 'contract_call',
    sequence: sequence ?? null,
    ...meta,
  };
  if (gas) tx.gas = gas;
  return tx;
}

/**
 * Devuelve un timestamp UNIX absoluto (segundos) para usar como `deadline`
 * en transacciones que requieren expiración.
 */
function deadlineFromNow(seconds = DEFAULT_DEADLINE_SECONDS) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

/**
 * Estructura de "approval requirement" para mostrar al usuario en la UI.
 */
function buildApprovalRequirement(token, spender, amount) {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    spender,
    amount: amount.toString(),
    formattedAmount: ethers.formatUnits(amount, token.decimals),
  };
}

/**
 * Construye una transacción ERC20 `approve(spender, MAX_UINT256)`. Usa MaxUint256
 * para evitar tener que volver a aprobar en operaciones futuras.
 */
function maybeBuildApprovalTx(token, spender, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(ERC20_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('approve', [spender, MAX_UINT256]),
    {
      chainId,
      kind: 'approval',
      label: `Approve ${token.symbol}`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        spender,
        amount: MAX_UINT256.toString(),
      },
    }
  );
}

/**
 * Si la allowance actual es insuficiente, agrega una approval al `txPlan` y
 * a la lista `requiresApproval`. No-op si la allowance ya es suficiente.
 */
function appendApprovalIfNeeded({ token, spender, amount, chainId, currentAllowance, requiresApproval, txPlan }) {
  if (currentAllowance >= amount) return false;
  requiresApproval.push(buildApprovalRequirement(token, spender, amount));
  const tx = maybeBuildApprovalTx(token, spender, amount, chainId);
  if (tx) txPlan.push(tx);
  return true;
}

/**
 * Construye una tx que envuelve token nativo (ETH/MATIC) en su versión wrapped
 * (WETH/WMATIC). Llama a `deposit()` enviando el monto como `value`.
 */
function buildWrapNativeTx(token, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(WRAPPED_NATIVE_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('deposit', []),
    {
      chainId,
      kind: 'wrap_native',
      label: `Wrap native to ${token.symbol}`,
      value: ethers.toBeHex(amount),
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        amount: amount.toString(),
      },
    }
  );
}

/**
 * Construye una tx que des-envuelve un token wrapped a su versión nativa.
 * Llama a `withdraw(amount)`.
 */
function buildUnwrapNativeTx(token, amount, chainId) {
  if (amount <= 0n) return null;
  const iface = new ethers.Interface(WRAPPED_NATIVE_ABI);
  return encodeTx(
    token.address,
    iface.encodeFunctionData('withdraw', [amount]),
    {
      chainId,
      kind: 'unwrap_native',
      label: `Unwrap ${token.symbol} to native`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        amount: amount.toString(),
      },
    }
  );
}

module.exports = {
  encodeTx,
  deadlineFromNow,
  buildApprovalRequirement,
  maybeBuildApprovalTx,
  appendApprovalIfNeeded,
  buildWrapNativeTx,
  buildUnwrapNativeTx,
};
