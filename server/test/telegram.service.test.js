const test = require('node:test');
const assert = require('node:assert/strict');

const httpClient = require('../src/shared/platform/http/http-client');
const TelegramService = require('../src/services/telegram.service');

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
