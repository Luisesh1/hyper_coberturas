const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApprovalTx } = require('../src/services/cross-chain/providers/approval');
const { createAcrossProvider } = require('../src/services/cross-chain/providers/across.provider');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const ARB_SPOKE = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NATIVE_HANDLER = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
const ZERO = '0x0000000000000000000000000000000000000000';

const usd = (amountUsd) => ({ amount: '1', amountUsd: String(amountUsd) });

function approvalBody({ spender = ARB_SPOKE, to = ARB_SPOKE, value } = {}) {
  return {
    approvalTxns: [{ chainId: 42161, to: ARB_USDC, data: buildApprovalTx({ token: ARB_USDC, spender, amountRaw: '100000000' }).data }],
    swapTx: { chainId: 42161, to, data: '0xfeed', gas: '0', ...(value ? { value } : {}) },
    inputAmount: '100000000',
    expectedOutputAmount: '99986284',
    minOutputAmount: '99980000',
    expectedFillTime: 2,
    quoteExpiryTimestamp: 1791249935,
    fees: {
      total: {
        details: {
          bridge: { ...usd(0.0137), details: { lp: usd(0), relayerCapital: usd(0.01), destinationGas: usd(0.0037) } },
          app: usd(0),
          swapImpact: usd(-0.00001),
        },
      },
    },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const { status = 200, body } = await handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const QUOTE_ARGS = {
  fromNetwork: 'arbitrum', toNetwork: 'base', fromToken: ARB_USDC, toToken: BASE_USDC,
  fromAmountRaw: '100000000', walletAddress: WALLET, slippageBps: 50,
};

test('quote de Across: approval decodificado, fees por concepto y tx normalizada', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: approvalBody() }));
  const quote = await createAcrossProvider({ fetchImpl }).quote(QUOTE_ARGS);
  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.pathname, '/api/swap/approval');
  assert.equal(url.searchParams.get('tradeType'), 'exactInput');
  assert.equal(url.searchParams.get('originChainId'), '42161');
  assert.equal(url.searchParams.get('destinationChainId'), '8453');
  assert.equal(url.searchParams.get('recipient'), WALLET);
  assert.equal(url.searchParams.get('slippage'), '0.005');
  assert.equal(quote.provider, 'across');
  assert.equal(quote.toAmountRaw, '99986284');
  assert.equal(quote.toAmountMinRaw, '99980000');
  assert.equal(quote.tx.to, ARB_SPOKE);
  assert.equal(quote.tx.value, '0');
  assert.equal(quote.tx.gasLimit, null, 'gas 0 = sin simulación, no un límite');
  assert.equal(quote.approvalTxs.length, 1);
  assert.equal(quote.approvalTxs[0].spender, ARB_SPOKE);
  assert.equal(quote.etaSec, 2);
  assert.equal(quote.expiresAt, 1791249935 * 1000);
  const names = quote.feeCosts.map((f) => f.name);
  assert.deepEqual(names, ['Relayer (Across)', 'Gas en destino (Across)']);
  assert.ok(quote.feeCosts.every((f) => f.included));
});

test('envío nativo de Across: sin approval y con value', async () => {
  const body = approvalBody({ to: NATIVE_HANDLER, value: '10000000000000000' });
  body.approvalTxns = [];
  const fetchImpl = fakeFetch(async () => ({ body }));
  const quote = await createAcrossProvider({ fetchImpl }).quote({ ...QUOTE_ARGS, fromToken: ZERO, toToken: ZERO, fromAmountRaw: '10000000000000000' });
  assert.deepEqual(quote.approvalTxs, []);
  assert.equal(quote.tx.value, '10000000000000000');
});

test('un spender fuera de la allowlist se rechaza', async () => {
  const fetchImpl = fakeFetch(async () => ({ body: approvalBody({ spender: '0x000000000000000000000000000000000000dEaD' }) }));
  await assert.rejects(createAcrossProvider({ fetchImpl }).quote(QUOTE_ARGS), (err) => err.code === 'BRIDGE_TARGET_NOT_ALLOWED');
});

test('un approve que no es approve se rechaza', async () => {
  const body = approvalBody();
  body.approvalTxns[0].data = '0x12345678';
  const fetchImpl = fakeFetch(async () => ({ body }));
  await assert.rejects(createAcrossProvider({ fetchImpl }).quote(QUOTE_ARGS), (err) => err.code === 'BRIDGE_TARGET_NOT_ALLOWED');
});

test('monto demasiado bajo → BRIDGE_QUOTE_FAILED con el mensaje de Across', async () => {
  const fetchImpl = fakeFetch(async () => ({ status: 400, body: { message: 'Bridge amount is too low' } }));
  await assert.rejects(
    createAcrossProvider({ fetchImpl }).quote(QUOTE_ARGS),
    (err) => err.code === 'BRIDGE_QUOTE_FAILED' && /too low/.test(err.message)
  );
});

test('estados de depósito de Across', async () => {
  const cases = [
    [{ status: 'filled', fillTx: '0x1' }, 'delivered'],
    [{ status: 'pending' }, 'pending'],
    [{ status: 'refunded', depositRefundTxHash: '0x2' }, 'refunded'],
    [{ status: 'expired' }, 'failed'],
    [{ error: 'DepositNotFoundException' }, 'pending'],
  ];
  for (const [body, expected] of cases) {
    const fetchImpl = fakeFetch(async () => ({ status: body.error ? 404 : 200, body }));
    const result = await createAcrossProvider({ fetchImpl }).status({ txHash: '0xabc', fromNetwork: 'arbitrum', toNetwork: 'base', ref: {} });
    assert.equal(result.status, expected, JSON.stringify(body));
    assert.equal(result.receivedRaw, null);
  }
  const fetchImpl = fakeFetch(async () => ({ body: { status: 'pending' } }));
  await createAcrossProvider({ fetchImpl }).status({ txHash: '0xabc', fromNetwork: 'arbitrum', toNetwork: 'base', ref: {} });
  const url = new URL(fetchImpl.calls[0]);
  assert.equal(url.pathname, '/api/deposit/status');
  assert.equal(url.searchParams.get('originChainId'), '42161');
  assert.equal(url.searchParams.get('depositTxHash'), '0xabc');
});
