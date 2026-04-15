const test = require('node:test');
const assert = require('node:assert/strict');

const httpClient = require('../src/shared/platform/http/http-client');

function loadServiceFresh() {
  const servicePath = require.resolve('../src/services/wallet-balance.service');
  delete require.cache[servicePath];
  return require(servicePath);
}

test('wallet balance reintenta Alchemy ante rate limit y cachea metadata de token', async () => {
  const originalPost = httpClient.post;
  let metadataCalls = 0;

  httpClient.post = async (url, body) => {
    if (url.includes('/info')) {
      return { data: { ETH: '3000' } };
    }

    if (body?.method === 'eth_getBalance') {
      return { data: { result: '0x0' } };
    }

    if (body?.method === 'alchemy_getTokenBalances') {
      return {
        data: {
          result: {
            tokenBalances: [
              {
                contractAddress: '0xToken',
                tokenBalance: '0xde0b6b3a7640000',
              },
            ],
          },
        },
      };
    }

    if (body?.method === 'alchemy_getTokenMetadata') {
      metadataCalls += 1;
      if (metadataCalls === 1) {
        const err = new Error('throughput exceeded');
        err.response = {
          status: 429,
          data: {
            error: {
              message: 'Your app has exceeded its compute units per second capacity',
            },
          },
        };
        throw err;
      }
      return {
        data: {
          result: {
            symbol: 'WETH',
            decimals: 18,
          },
        },
      };
    }

    throw new Error(`Unexpected RPC method: ${body?.method}`);
  };

  try {
    const walletBalanceService = loadServiceFresh();
    const first = await walletBalanceService.getAllTokenBalancesUsd('0xwallet');
    const second = await walletBalanceService.getAllTokenBalancesUsd('0xwallet');

    assert.equal(metadataCalls, 2);
    assert.equal(first.tokens.length, 1);
    assert.equal(second.tokens.length, 1);
    assert.equal(first.tokens[0].symbol, 'WETH');
    assert.equal(second.tokens[0].symbol, 'WETH');
    assert.equal(first.tokens[0].valueUsd, 3000);
  } finally {
    httpClient.post = originalPost;
  }
});
