const test = require('node:test');
const assert = require('node:assert/strict');

const httpClient = require('../src/shared/platform/http/http-client');
const TelegramService = require('../src/services/telegram.service');

function stubHttpPost(impl) {
  const original = httpClient.post;
  httpClient.post = impl;
  return () => { httpClient.post = original; };
}

test('TelegramService respeta retry_after antes de reintentar envios', async () => {
  const originalPost = httpClient.post;
  let attempts = 0;

  httpClient.post = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('Too Many Requests');
      err.response = {
        status: 429,
        data: {
          parameters: { retry_after: 0.01 },
        },
      };
      throw err;
    }
    return { data: { ok: true, result: { message_id: 1 } } };
  };

  try {
    const service = new TelegramService('bot-token', 'chat-id');
    const result = await service.send('hola');

    assert.equal(attempts, 2);
    assert.equal(result?.ok, true);
  } finally {
    httpClient.post = originalPost;
  }
});

test('TelegramService suprime envios cuando la categoria esta desactivada', async () => {
  const posts = [];
  const restore = stubHttpPost(async (url, payload) => {
    posts.push({ url, payload });
    return { data: { ok: true } };
  });

  try {
    const service = new TelegramService('bot-token', 'chat-id', {
      userId: 99,
      notificationPrefs: {
        silencedUntil: null,
        quietHours: null,
        categories: { hedge: false, trade: true, runtime: true, deltaNeutralBlock: true },
        digest: { enabled: false, windowMs: 30_000, minEvents: 3 },
      },
    });
    await service.notifyHedgeCreated({ asset: 'BTC', direction: 'short', leverage: 3, entryPrice: 1, exitPrice: 2, size: 0.1 });
    assert.equal(posts.length, 0, 'no debe enviar cuando la categoria esta off');

    const alerts = TelegramService.listRecentAlerts(99);
    assert.ok(alerts.length >= 1, 'debe registrar en el buffer aunque suprima el envio');
    assert.equal(alerts[0].category, 'hedge');
  } finally {
    restore();
  }
});

test('TelegramService suprime envios mientras hay silencio temporal activo', async () => {
  const posts = [];
  const restore = stubHttpPost(async (url, payload) => {
    posts.push({ url, payload });
    return { data: { ok: true } };
  });

  try {
    const service = new TelegramService('bot-token', 'chat-id', {
      userId: 100,
      notificationPrefs: {
        silencedUntil: Date.now() + 60_000,
        quietHours: null,
        categories: { hedge: true, trade: true, runtime: true, deltaNeutralBlock: true },
        digest: { enabled: false, windowMs: 30_000, minEvents: 3 },
      },
    });
    await service.notifyHedgeCreated({ asset: 'ETH', direction: 'short', leverage: 3, entryPrice: 1, exitPrice: 2, size: 0.1 });
    assert.equal(posts.length, 0, 'silencio suprime alertas no criticas');

    await service.notifyHedgeError({ id: 1, asset: 'ETH', status: 'error' }, new Error('boom'));
    assert.equal(posts.length, 1, 'hedge_error es critical y se envia aunque haya silencio');
  } finally {
    restore();
  }
});

test('TelegramService agrupa eventos runtime en un digest', async () => {
  const posts = [];
  const restore = stubHttpPost(async (url, payload) => {
    posts.push({ url, payload });
    return { data: { ok: true } };
  });

  try {
    const service = new TelegramService('bot-token', 'chat-id', {
      userId: 101,
      notificationPrefs: {
        silencedUntil: null,
        quietHours: null,
        categories: { hedge: true, trade: true, runtime: true, deltaNeutralBlock: true },
        digest: { enabled: true, windowMs: 50, minEvents: 3 },
      },
    });

    const bot = { id: 42, asset: 'BTC', status: 'active' };
    await service.notifyBotRuntimeEvent('runtime_warning', bot, { message: 'a', stage: 'x' });
    await service.notifyBotRuntimeEvent('runtime_warning', bot, { message: 'b', stage: 'x' });
    await service.notifyBotRuntimeEvent('runtime_warning', bot, { message: 'c', stage: 'x' });
    assert.equal(posts.length, 0, 'los eventos se acumulan, no se envian inmediatamente');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(posts.length, 1, 'al expirar la ventana se envia un solo mensaje consolidado');
    assert.match(posts[0].payload.text, /3 eventos/);
    assert.match(posts[0].payload.text, /Bot #42/);
  } finally {
    restore();
  }
});
