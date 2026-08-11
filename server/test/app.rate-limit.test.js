const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'production';
process.env.CLIENT_URL = 'https://hypercover.test';
process.env.JWT_SECRET = 'rate-limit-test-secret-with-enough-entropy';
process.env.SETTINGS_ENCRYPTION_KEY = 'rate-limit-test-encryption-key-32-bytes';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';

const app = require('../src/app');

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('rate limit separa clientes que llegan por distintas IP detrás de Nginx', async () => {
  const [first, second] = await withServer(async (baseUrl) => {
    const a = await fetch(`${baseUrl}/`, {
      headers: { 'X-Forwarded-For': '198.51.100.21' },
    });
    const b = await fetch(`${baseUrl}/`, {
      headers: { 'X-Forwarded-For': '198.51.100.22' },
    });
    return [a, b];
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('ratelimit-remaining'), second.headers.get('ratelimit-remaining'));
});

test('rate limit separa usuarios autenticados aunque compartan IP', async () => {
  const tokenFor = (userId) => jwt.sign(
    { userId, username: `user-${userId}`, role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  const [first, second] = await withServer(async (baseUrl) => {
    const a = await fetch(`${baseUrl}/`, {
      headers: {
        'X-Forwarded-For': '198.51.100.30',
        Authorization: `Bearer ${tokenFor(101)}`,
      },
    });
    const b = await fetch(`${baseUrl}/`, {
      headers: {
        'X-Forwarded-For': '198.51.100.30',
        Authorization: `Bearer ${tokenFor(102)}`,
      },
    });
    return [a, b];
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get('ratelimit-remaining'), second.headers.get('ratelimit-remaining'));
});
