/**
 * Helpers para interactuar con el contrato Permit2 de Uniswap V4.
 * Centraliza la consulta de estado y la construcción de aprobaciones.
 */

const { ethers } = require('ethers');
const onChainManager = require('../onchain-manager.service');
const {
  DEFAULT_PERMIT2_EXPIRATION_SECONDS,
  PERMIT2_ABI,
  PERMIT2_ADDRESS,
  buildPermit2ApproveCalldata,
} = require('../uniswap-v4-helpers.service');
const { ERC20_ABI } = require('./abis');
const { encodeTx } = require('./tx-encoders');

/**
 * Estructura "approval requirement" para Permit2 (mostrar al usuario en UI).
 */
function buildPermit2ApprovalRequirement(token, spender, amount, permit2Address) {
  return {
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    spender,
    permit2Address,
    amount: amount.toString(),
    formattedAmount: ethers.formatUnits(amount, token.decimals),
    type: 'permit2_approval',
  };
}

/**
 * Construye la tx que llama a `Permit2.approve(token, spender, amount, expiration)`.
 */
function buildPermit2ApproveTx(token, spender, amount, chainId, permit2Address) {
  if (amount <= 0n) return null;
  return encodeTx(
    permit2Address,
    buildPermit2ApproveCalldata(
      token.address,
      spender,
      amount,
      BigInt(Math.floor(Date.now() / 1000) + DEFAULT_PERMIT2_EXPIRATION_SECONDS)
    ),
    {
      chainId,
      kind: 'permit2_approval',
      label: `Permit2 approve ${token.symbol}`,
      meta: {
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        spender,
        amount: amount.toString(),
        permit2Address,
      },
    }
  );
}

/**
 * Lee on-chain el estado de Permit2 para una pareja (token, spender):
 * - balance del token en la wallet
 * - allowance del token hacia Permit2
 * - allowance interna de Permit2 hacia el spender
 */
async function getPermit2State(provider, token, walletAddress, spender, permit2Address = PERMIT2_ADDRESS) {
  const tokenContract = onChainManager.getContract({ runner: provider, address: token.address, abi: ERC20_ABI });
  const permit2 = onChainManager.getContract({ runner: provider, address: permit2Address, abi: PERMIT2_ABI });
  const [[balance, tokenAllowance], permit2Allowance] = await Promise.all([
    Promise.all([
      tokenContract.balanceOf(walletAddress).catch(() => 0n),
      tokenContract.allowance(walletAddress, permit2Address).catch(() => 0n),
    ]),
    permit2.allowance(walletAddress, token.address, spender).catch(() => [0n, 0n, 0n]),
  ]);

  return {
    balance,
    tokenAllowanceToPermit2: BigInt(tokenAllowance || 0n),
    permit2AllowanceAmount: BigInt(Array.isArray(permit2Allowance) ? permit2Allowance[0] || 0n : 0n),
  };
}

module.exports = {
  buildPermit2ApprovalRequirement,
  buildPermit2ApproveTx,
  getPermit2State,
};
