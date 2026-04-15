const test = require('node:test');
const assert = require('node:assert/strict');

const httpClient = require('../src/shared/platform/http/http-client');
const HyperliquidService = require('../src/services/hyperliquid.service');

test('HyperliquidService reintenta lecturas /info cuando recibe 429', async () => {
  const originalPost = httpClient.post;
  let attempts = 0;

  httpClient.post = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('rate limited');
      err.response = {
        status: 429,
        headers: { 'retry-after': '0.01' },
        data: { error: 'rate limited' },
      };
      throw err;
    }
    return { data: { BTC: '100000' } };
  };

  try {
    const service = new HyperliquidService({});
    const mids = await service.getAllMids();

    assert.equal(attempts, 2);
    assert.deepEqual(mids, { BTC: '100000' });
  } finally {
    httpClient.post = originalPost;
  }
});
