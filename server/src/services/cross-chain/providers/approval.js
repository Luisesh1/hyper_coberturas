const { ethers } = require('ethers');

const ERC20_IFACE = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);

function buildApprovalTx({ token, spender, amountRaw }) {
  return {
    to: token,
    data: ERC20_IFACE.encodeFunctionData('approve', [spender, BigInt(amountRaw)]),
    value: '0',
    spender,
  };
}

function decodeApproval(data) {
  try {
    const [spender, amount] = ERC20_IFACE.decodeFunctionData('approve', data);
    return { spender: ethers.getAddress(spender), amountRaw: amount.toString() };
  } catch {
    return null;
  }
}

module.exports = { buildApprovalTx, decodeApproval };
