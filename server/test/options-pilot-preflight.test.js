const test = require('node:test');
const assert = require('node:assert/strict');
const { assessPreflight, formatSanitized, eligibleEthContracts, accountIsolated } =
  require('../src/scripts/options-pilot-preflight');

const at = Date.UTC(2026, 9, 16);
function client(overrides = {}) {
  return {
    getExchangeInfo: async () => ({ optionSymbols: [{
      symbol: 'ETH-261030-4000-C',
      status: 'TRADING',
      underlying: 'ETHUSDT',
      quoteAsset: 'USDT',
      unit: 1,
      expiryDate: at + 14 * 86400_000,
      filters: [{ filterType: 'PRICE_FILTER', minPrice: '0.01',
        maxPrice: '10000', tickSize: '0.01', minQty: '0.01',
        maxQty: '100', stepSize: '0.01' }],
    }] }),
    getTicker: async () => [{ symbol: 'ETH-261030-4000-C',
      bidPrice: '1.99', askPrice: '2.00' }],
    getDepth: async () => ({ bids: [['1.99', '5']], asks: [['2.00', '5']] }),
    getAccount: async () => ({ asset: [], greek: [] }),
    getApiRestrictions: async () => ({
      ipRestrict: true, enableWithdrawals: false,
      enableReading: true, enableVanillaOptions: true,
    }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    ...overrides,
  };
}
const flagsOff = { OPTIONS_LIVE_TRADING_ENABLED: 'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED: 'false' };

test('preflight sano inspecciona mercado ETH, cuenta aislada y permisos sin operar', async () => {
  const c = client();
  c.placeOrder = () => { throw Error('no placing orders'); };
  c.cancelOrder = () => { throw Error('no cancelling orders'); };
  const result = await assessPreflight({ client: c, at, env: flagsOff });
  assert.equal(result.technicalStatus, 'pass');
  assert.equal(result.pilotReady, false);
  assert.equal(result.checks.filter(x => x.status === 'unverified').length, 4);
  const output = formatSanitized(result).join('\n');
  assert.match(output, /pilot_technical_status=pass/);
  assert.match(output, /pilot_ready=no/);
});

test('interlock falla con cualquier flag true y con permisos inseguros', async () => {
  const c = client({ getApiRestrictions: async () =>
    ({ ipRestrict: false, enableWithdrawals: true }) });
  const result = await assessPreflight({ client: c, at, env: {
    ...flagsOff, OPTIONS_LIVE_TRADING_ENABLED: 'true',
  } });
  const text = formatSanitized(result).join('\n');
  assert.equal(result.technicalStatus, 'fail');
  assert.match(text, /pilot_liveFlagsOff=fail/);
  assert.match(text, /pilot_apiPermissions=fail/);
});

test('exposición u órdenes abiertas bloquean el preflight', async () => {
  const c = client({ getOpenOrders: async () => [{ orderId: 'secret' }] });
  const result = await assessPreflight({ client: c, at, env: flagsOff });
  assert.equal(result.technicalStatus, 'fail');
  assert.equal(result.checks.find(c => c.name === 'isolatedAccount').status, 'fail');
  assert.equal(accountIsolated([{ quantity: '-0.1' }], []), false);
});

test('tick/lot no negociables no se aproximan ni convierten en oportunidades', async () => {
  const c = client({ getTicker: async () => [{ symbol: 'ETH-261030-4000-C',
    bidPrice: '1.99', askPrice: '2.005' }] });
  const info = await c.getExchangeInfo();
  assert.deepEqual(eligibleEthContracts(info, await c.getTicker(), at), []);
  const result = await assessPreflight({ client: c, at, env: flagsOff });
  assert.equal(result.technicalStatus, 'fail');
});

test('sin mercado / account endpoint no se interpreta como elegible', async () => {
  const c = client({ getExchangeInfo: async () => null,
    getAccount: async () => { throw Error('secret provider message'); } });
  const result = await assessPreflight({ client: c, at, env: flagsOff });
  assert.equal(result.technicalStatus, 'fail');
  assert.doesNotMatch(formatSanitized(result).join('\n'), /secret provider message/);
});

test('sanitizador nunca publica balances, símbolos ni identifiers', async () => {
  const result = await assessPreflight({ client: client(), at, env: flagsOff });
  result.accountBalance = 'INTERNAL_BALANCE';
  result.symbol = 'ETH-261030-4000-C';
  result.userId = 1;
  const text = formatSanitized(result).join('\n');
  assert.doesNotMatch(text, /INTERNAL_BALANCE|ETH-261030|userId/);
  assert.throws(() => formatSanitized({ ...result, pilotReady: true }));
});
