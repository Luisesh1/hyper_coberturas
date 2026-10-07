/**
 * Contrato con las APIs reales de Li.Fi y Across: solo cotizaciones, sin
 * firmar nada. Detecta cambios de formato o de contratos (allowlist) antes de
 * que lleguen a un usuario. No corre en `npm test`: `npm run test:providers`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLifiProvider } = require('../src/services/cross-chain/providers/lifi.provider');
const { createAcrossProvider } = require('../src/services/cross-chain/providers/across.provider');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = {
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};
const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const ROUTES = [
  ['arbitrum', 'base', USDC.arbitrum, USDC.base, '100000000'],
  ['base', 'arbitrum', ZERO, ZERO, '20000000000000000'],
  ['optimism', 'base', USDC.optimism, USDC.base, '100000000'],
  ['arbitrum', 'robinhood', USDC.arbitrum, RH_USDG, '100000000'],
];

for (const [name, provider] of [['Li.Fi', createLifiProvider()], ['Across', createAcrossProvider()]]) {
  for (const [from, to, fromToken, toToken, amount] of ROUTES) {
    test(`${name}: ${from} → ${to} cotiza con contratos de la allowlist`, async () => {
      const quote = await provider.quote({
        fromNetwork: from, toNetwork: to, fromToken, toToken, fromAmountRaw: amount, walletAddress: WALLET, slippageBps: 50,
      });
      assert.ok(BigInt(quote.toAmountRaw) > 0n);
      assert.ok(BigInt(quote.toAmountMinRaw) <= BigInt(quote.toAmountRaw));
      assert.match(quote.tx.data, /^0x[0-9a-f]+$/i);
      assert.equal(quote.approvalTxs.length > 0, fromToken !== ZERO);
      assert.ok(Array.isArray(quote.feeCosts));
    });
  }
}
