const test = require('node:test');
const assert = require('node:assert/strict');

const { createEtherscanQueueClient } = require('../src/services/etherscan-queue.service');

test('etherscan queue respeta el limite de 3 requests por segundo bajo concurrencia', async () => {
  const startedAt = [];
  const client = createEtherscanQueueClient({
    maxRequestsPerSecond: 3,
    axiosInstance: {
      get: async () => {
        startedAt.push(Date.now());
        return { data: { status: '1', result: [] } };
      },
    },
    queueLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

  await Promise.all(
    Array.from({ length: 5 }, (_, index) => client.request('key', {
      module: 'account',
      action: `txlist-${index}`,
    }))
  );

  assert.equal(startedAt.length, 5);
  assert.ok(startedAt[3] - startedAt[0] >= 950);
});
