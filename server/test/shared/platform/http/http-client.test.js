const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { URLSearchParams } = require('node:url');

const httpClient = require('../../../../src/shared/platform/http/http-client');

/**
 * Levanta un servidor HTTP efímero en puerto 0 para probar el helper contra
 * una implementación real sin mockear fetch global.
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

/**
 * Helper para leer el body de un request como JSON/text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

test('GET con params serializa querystring correctamente', async () => {
  let receivedUrl = null;
  const srv = await startServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await httpClient.get(`${srv.baseUrl}/api`, {
      params: { a: 1, b: 'hello world', skip: undefined, also: null, keep: 0 },
    });
    assert.ok(receivedUrl.includes('a=1'));
    assert.ok(receivedUrl.includes('b=hello+world') || receivedUrl.includes('b=hello%20world'));
    assert.ok(!receivedUrl.includes('skip='));
    assert.ok(!receivedUrl.includes('also='));
    assert.ok(receivedUrl.includes('keep=0'));
  } finally {
    await srv.close();
  }
});

test('GET retorna { data, status, headers } con JSON parseado', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, count: 42 }));
  });

  try {
    const response = await httpClient.get(`${srv.baseUrl}/api`);
    assert.equal(response.data.ok, true);
    assert.equal(response.data.count, 42);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('application/json'));
  } finally {
    await srv.close();
  }
});

test('POST con objeto hace JSON stringify y añade Content-Type automático', async () => {
  let receivedBody = null;
  let receivedContentType = null;
  const srv = await startServer(async (req, res) => {
    receivedContentType = req.headers['content-type'];
    receivedBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await httpClient.post(`${srv.baseUrl}/api`, { name: 'foo', count: 7 });
    assert.ok(receivedContentType.includes('application/json'));
    assert.deepEqual(JSON.parse(receivedBody), { name: 'foo', count: 7 });
  } finally {
    await srv.close();
  }
});

test('POST respeta headers custom del caller', async () => {
  let receivedAuth = null;
  const srv = await startServer((req, res) => {
    receivedAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await httpClient.post(`${srv.baseUrl}/api`, { x: 1 }, {
      headers: { Authorization: 'Bearer xxx' },
    });
    assert.equal(receivedAuth, 'Bearer xxx');
  } finally {
    await srv.close();
  }
});

test('Timeout aborta request y lanza error con code ECONNABORTED', async () => {
  // Server que nunca responde hasta que se cierre
  const pending = [];
  const srv = await startServer((req, res) => {
    pending.push({ req, res });
  });

  try {
    await assert.rejects(
      httpClient.get(`${srv.baseUrl}/slow`, { timeout: 50 }),
      (err) => {
        assert.ok(err.isHttpError);
        assert.equal(err.code, 'ECONNABORTED');
        assert.match(err.message, /timeout of 50ms exceeded/);
        return true;
      }
    );
  } finally {
    // Desbloquear el handler colgado para que el servidor pueda cerrar
    for (const { res } of pending) {
      try { res.end(); } catch { /* noop */ }
    }
    await srv.close();
  }
});

test('Status 404 lanza HttpError con err.response.status === 404', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  try {
    await assert.rejects(
      httpClient.get(`${srv.baseUrl}/missing`),
      (err) => {
        assert.equal(err.isHttpError, true);
        assert.equal(err.response.status, 404);
        assert.equal(err.response.data.error, 'not found');
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('Status 500 con body text/plain se expone como string en err.response.data', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Error');
  });

  try {
    await assert.rejects(
      httpClient.get(`${srv.baseUrl}/broken`),
      (err) => {
        assert.equal(err.response.status, 500);
        assert.equal(err.response.data, 'Internal Error');
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('Shape de response compatible con mocks { data: ... }', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: [1, 2, 3] }));
  });

  try {
    // Destructuring como hace el código de etherscan-queue y uniswap.service
    const { data } = await httpClient.get(`${srv.baseUrl}/list`);
    assert.deepEqual(data, { result: [1, 2, 3] });
  } finally {
    await srv.close();
  }
});

test('Params como URLSearchParams directamente', async () => {
  let receivedUrl = null;
  const srv = await startServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  try {
    const params = new URLSearchParams({ foo: 'bar', baz: 'qux' });
    await httpClient.get(`${srv.baseUrl}/api`, { params });
    assert.ok(receivedUrl.includes('foo=bar'));
    assert.ok(receivedUrl.includes('baz=qux'));
  } finally {
    await srv.close();
  }
});

test('POST con body null no añade Content-Type application/json automático', async () => {
  let receivedContentType = null;
  let receivedBody = null;
  const srv = await startServer(async (req, res) => {
    receivedContentType = req.headers['content-type'];
    receivedBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  try {
    await httpClient.post(`${srv.baseUrl}/api`, null);
    // Sin body JSON: no debe añadirse Content-Type automáticamente
    assert.equal(receivedContentType, undefined);
    assert.equal(receivedBody, '');
  } finally {
    await srv.close();
  }
});
