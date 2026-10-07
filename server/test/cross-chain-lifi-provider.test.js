const test = require('node:test');
const assert = require('node:assert/strict');

const { assertAllowedTarget, isAllowedTarget } = require('../src/services/cross-chain/bridge-allowlist');
const { buildApprovalTx, decodeApproval } = require('../src/services/cross-chain/providers/approval');
const { createLifiProvider } = require('../src/services/cross-chain/providers/lifi.provider');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ZERO = '0x0000000000000000000000000000000000000000';

function quoteBody(overrides = {}) {
  return {
    tool: 'across',
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: '0xabcdef',
      value: '0x0',
      chainId: 42161,
      gasLimit: '0x61a80',
      ...overrides.transactionRequest,
    },
    estimate: {
      approvalAddress: LIFI_DIAMOND,
      toAmount: '99750000',
      toAmountMin: '99500000',
      executionDuration: 2,
      feeCosts: [
        { name: 'LIFI Fixed Fee', amountUSD: '0.25', included: true },
        { name: 'Relayer fee', amountUSD: '0.01', included: true },
        { name: 'Gas en destino', amountUSD: '0.30', included: false },
      ],
      ...overrides.estimate,
    },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = await handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('allowlist: Li.Fi Diamond en Arbitrum sí; dirección cualquiera no', () => {
  assert.equal(isAllowedTarget({ provider: 'lifi', network: 'arbitrum', to: LIFI_DIAMOND.toLowerCase() }), true);
  assert.equal(isAllowedTarget({ provider: 'lifi', network: 'robinhood', to: '0xB477751B76CF82d00a686A1232f5fCD772414Af3' }), true);
  assert.equal(isAllowedTarget({ provider: 'across', network: 'arbitrum', to: LIFI_DIAMOND }), false);
  assert.throws(
    () => assertAllowedTarget({ provider: 'lifi', network: 'base', to: '0x000000000000000000000000000000000000dEaD' }),
    (err) => err.code === 'BRIDGE_TARGET_NOT_ALLOWED'
  );
});

test('approve: se construye y se decodifica ida y vuelta', () => {
  const tx = buildApprovalTx({ token: ARB_USDC, spender: LIFI_DIAMOND, amountRaw: '100000000' });
  assert.equal(tx.to, ARB_USDC);
  assert.equal(tx.value, '0');
  assert.equal(tx.spender, LIFI_DIAMOND);
  const decoded = decodeApproval(tx.data);
  assert.equal(decoded.spender, LIFI_DIAMOND);
  assert.equal(decoded.amountRaw, '100000000');
  assert.equal(decodeApproval('0x12345678'), null);
});

test('quote de Li.Fi se normaliza con approval para un ERC20', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody() }));
  const provider = createLifiProvider({ fetchImpl });
  const quote = await provider.quote({
    fromNetwork: 'arbitrum',
    toNetwork: 'base',
    fromToken: ARB_USDC,
    toToken: BASE_USDC,
    fromAmountRaw: '100000000',
    walletAddress: WALLET,
    slippageBps: 50,
  });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/v1/quote');
  assert.equal(url.searchParams.get('fromChain'), '42161');
  assert.equal(url.searchParams.get('toChain'), '8453');
  assert.equal(url.searchParams.get('toAddress'), WALLET);
  assert.equal(url.searchParams.get('slippage'), '0.005');
  assert.equal(quote.provider, 'lifi');
  assert.equal(quote.tool, 'across');
  assert.equal(quote.toAmountRaw, '99750000');
  assert.equal(quote.toAmountMinRaw, '99500000');
  assert.equal(quote.tx.to, LIFI_DIAMOND);
  assert.equal(quote.tx.value, '0');
  assert.equal(quote.tx.chainId, 42161);
  assert.equal(quote.tx.gasLimit, '400000');
  assert.equal(quote.approvalTxs.length, 1);
  assert.equal(quote.approvalTxs[0].to, ARB_USDC);
  assert.equal(quote.etaSec, 2);
  assert.deepEqual(quote.feeCosts[0], { name: 'LIFI Fixed Fee', amountUsd: 0.25, included: true });
  assert.equal(quote.feeCosts[2].included, false);
});

test('envío de nativo: sin approval', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody({ transactionRequest: { value: '0x2386f26fc10000' } }) }));
  const quote = await createLifiProvider({ fetchImpl }).quote({
    fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ZERO, toToken: ZERO,
    fromAmountRaw: '10000000000000000', walletAddress: WALLET, slippageBps: 50,
  });
  assert.deepEqual(quote.approvalTxs, []);
  assert.equal(quote.tx.value, '10000000000000000');
});

test('un destino fuera de la allowlist se rechaza', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody({ transactionRequest: { to: '0x000000000000000000000000000000000000dEaD' } }) }));
  await assert.rejects(
    createLifiProvider({ fetchImpl }).quote({
      fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
      fromAmountRaw: '1', walletAddress: WALLET, slippageBps: 50,
    }),
    (err) => err.code === 'BRIDGE_TARGET_NOT_ALLOWED'
  );
});

test('un error HTTP se convierte en BRIDGE_QUOTE_FAILED con el mensaje del proveedor', async () => {
  const fetchImpl = fakeFetch(async () => ({ status: 404, body: { message: 'No available quotes' } }));
  await assert.rejects(
    createLifiProvider({ fetchImpl }).quote({
      fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
      fromAmountRaw: '1', walletAddress: WALLET, slippageBps: 50,
    }),
    (err) => err.code === 'BRIDGE_QUOTE_FAILED' && /No available quotes/.test(err.message)
  );
});

test('la API key, si existe, viaja en la cabecera', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody() }));
  await createLifiProvider({ fetchImpl, apiKey: 'k-123' }).quote({
    fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
    fromAmountRaw: '1', walletAddress: WALLET, slippageBps: 50,
  });
  assert.equal(fetchImpl.calls[0].init.headers['x-lifi-api-key'], 'k-123');
});

test('estado de Li.Fi: completado, reembolsado, fallido, pendiente', async () => {
  const cases = [
    [{ status: 'DONE', substatus: 'COMPLETED', receiving: { amount: '99700000' } }, { status: 'delivered', receivedRaw: '99700000' }],
    [{ status: 'DONE', substatus: 'PARTIAL', receiving: { amount: '5' } }, { status: 'delivered', receivedRaw: '5' }],
    [{ status: 'DONE', substatus: 'REFUNDED' }, { status: 'refunded', receivedRaw: null }],
    [{ status: 'FAILED', substatusMessage: 'boom' }, { status: 'failed', receivedRaw: null }],
    [{ status: 'PENDING' }, { status: 'pending', receivedRaw: null }],
    [{ status: 'NOT_FOUND' }, { status: 'pending', receivedRaw: null }],
  ];
  for (const [body, expected] of cases) {
    const fetchImpl = fakeFetch(async () => ({ body }));
    const result = await createLifiProvider({ fetchImpl }).status({
      txHash: '0xabc', fromNetwork: 'arbitrum', toNetwork: 'base', ref: { tool: 'across' },
    });
    assert.equal(result.status, expected.status, JSON.stringify(body));
    assert.equal(result.receivedRaw, expected.receivedRaw);
  }
});

test('NOT_FOUND del status llega como 404 y sigue siendo pendiente', async () => {
  const fetchImpl = fakeFetch(async () => ({ status: 404, body: { status: 'NOT_FOUND', message: 'not found' } }));
  const result = await createLifiProvider({ fetchImpl }).status({
    txHash: '0xabc', fromNetwork: 'arbitrum', toNetwork: 'base', ref: {},
  });
  assert.equal(result.status, 'pending');
});

test('una cotización cuyo mínimo recibido excede el slippage se rechaza', async () => {
  // 50 bps sobre 99.750.000 permite hasta 99.251.250; 90.000.000 es demasiado.
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody({ estimate: { toAmountMin: '90000000' } }) }));
  await assert.rejects(
    createLifiProvider({ fetchImpl }).quote({
      fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
      fromAmountRaw: '100000000', walletAddress: WALLET, slippageBps: 50,
    }),
    (err) => err.code === 'BRIDGE_SLIPPAGE_TOO_HIGH'
  );
});

test('el redondeo del proveedor en el borde del slippage se acepta (caso real de Li.Fi: 50,0045 bps)', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: quoteBody({ estimate: { toAmount: '19948200000000000', toAmountMin: '19848450000000000' } }) }));
  const quote = await createLifiProvider({ fetchImpl }).quote({
    fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
    fromAmountRaw: '100000000', walletAddress: WALLET, slippageBps: 50,
  });
  assert.equal(quote.toAmountMinRaw, '19848450000000000');
});
