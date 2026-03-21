const test = require('node:test');
const assert = require('node:assert/strict');

const { TelegramCommandService } = require('../src/services/telegram-command.service');

function buildService(overrides = {}) {
  const calls = [];
  const tradingCalls = [];

  const tg = {
    sendToChat: async (chatId, text, options = {}) => {
      calls.push({ type: 'send', chatId, text, options });
      return { ok: true };
    },
    answerCallbackQuery: async (id, options = {}) => {
      calls.push({ type: 'answer', id, options });
      return { ok: true };
    },
  };

  const service = new TelegramCommandService({
    axios: { post: async () => ({ data: { result: [] } }) },
    logger: { info() {}, warn() {}, error() {} },
    settingsService: {
      listTelegramConfigs: async () => [],
      ...(overrides.settingsService || {}),
    },
    telegramRegistry: {
      get: () => tg,
      getOrCreate: async () => tg,
      ...(overrides.telegramRegistry || {}),
    },
    hyperliquidAccountsService: {
      listAccounts: async () => ([{
        id: 7,
        alias: 'Cuenta Alpha',
        shortAddress: '0x0000...00AA',
      }]),
      ...(overrides.hyperliquidAccountsService || {}),
    },
    tradingFactory: overrides.tradingFactory || (async (_userId, accountId) => {
      tradingCalls.push(accountId);
      return {
        getAccountState: async ({ force = false } = {}) => ({
          accountValue: 1250.5,
          withdrawable: 900.25,
          totalMarginUsed: 120.75,
          totalNtlPos: 540.11,
          positions: [],
          lastUpdatedAt: 1_710_000_000_000,
          forceUsed: force,
        }),
        getOpenOrders: async ({ force = false } = {}) => ({
          orders: [],
          lastUpdatedAt: 1_710_000_000_000,
          forceUsed: force,
        }),
      };
    }),
    ...overrides.service,
  });

  const poller = {
    token: 'bot-token',
    offset: 0,
    stopped: false,
    configsByChatId: new Map([
      ['999', { userId: 1, token: 'bot-token', chatId: '999', enabled: true }],
    ]),
  };

  return { service, tg, calls, tradingCalls, poller };
}

test('telegram command service responde /saldo directo cuando solo hay una cuenta', async () => {
  const { service, calls, tradingCalls, poller } = buildService();

  await service._handleMessage(poller, {
    chat: { id: '999' },
    text: '/saldo',
  });

  assert.deepEqual(tradingCalls, [7]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'send');
  assert.match(calls[0].text, /Saldo de Cuenta Alpha/);
  assert.equal(
    calls[0].options.replyMarkup.inline_keyboard[0][0].callback_data,
    'tg:bal:7:1'
  );
});

test('telegram command service pide elegir cuenta en /posiciones cuando hay varias cuentas', async () => {
  const { service, calls, tradingCalls, poller } = buildService({
    hyperliquidAccountsService: {
      listAccounts: async () => ([
        { id: 7, alias: 'Cuenta Alpha', shortAddress: '0x0000...00AA' },
        { id: 8, alias: 'Cuenta Beta', shortAddress: '0x0000...00BB' },
      ]),
    },
  });

  await service._handleMessage(poller, {
    chat: { id: '999' },
    text: '/posiciones',
  });

  assert.deepEqual(tradingCalls, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Selecciona una cuenta/);
  assert.equal(
    calls[0].options.replyMarkup.inline_keyboard[0][0].callback_data,
    'tg:pos:7:0'
  );
  assert.equal(
    calls[0].options.replyMarkup.inline_keyboard[1][0].callback_data,
    'tg:pos:8:0'
  );
});

test('telegram command service procesa callback de refresco de ordenes', async () => {
  const callbackCalls = [];
  const { service, calls, poller } = buildService({
    tradingFactory: async (_userId, accountId) => ({
      getAccountState: async () => ({ positions: [], lastUpdatedAt: 1_710_000_000_000 }),
      getOpenOrders: async ({ force = false } = {}) => {
        callbackCalls.push({ accountId, force });
        return {
          orders: [{
            oid: 123,
            coin: 'BTC',
            side: 'B',
            orderType: 'Limit',
            sz: '0.0100',
            limitPx: '70250',
          }],
          lastUpdatedAt: 1_710_000_000_000,
        };
      },
    }),
  });

  await service._handleCallback(poller, {
    id: 'cbq-1',
    data: 'tg:ord:7:1',
    message: {
      chat: { id: '999' },
    },
  });

  assert.deepEqual(callbackCalls, [{ accountId: 7, force: true }]);
  assert.equal(calls[0].type, 'answer');
  assert.equal(calls[1].type, 'send');
  assert.match(calls[1].text, /Órdenes abiertas/);
  assert.match(calls[1].text, /BTC/);
});

test('telegram command service ignora chats no autorizados', async () => {
  const { service, calls, tradingCalls, poller } = buildService();

  await service._handleMessage(poller, {
    chat: { id: '123456' },
    text: '/saldo',
  });

  assert.deepEqual(tradingCalls, []);
  assert.deepEqual(calls, []);
});
