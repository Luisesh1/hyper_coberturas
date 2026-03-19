const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const db = require('../src/db');
const authService = require('../src/services/auth.service');
const settingsService = require('../src/services/settings.service');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function buildToken(payload = {}) {
  return jwt.sign({
    userId: 1,
    username: 'stale-user',
    name: 'Stale Name',
    role: 'user',
    ...payload,
  }, config.jwt.secret);
}

function buildUserRow(overrides = {}) {
  return {
    id: 1,
    username: 'tester',
    password_hash: 'hash',
    name: 'Tester Actual',
    role: 'superuser',
    active: true,
    created_at: 1710000000000,
    updated_at: 1710000100000,
    ...overrides,
  };
}

test('GET /api/auth/me devuelve el usuario actual de base aunque el token tenga claims viejos', async () => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [buildUserRow()] });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.id, 1);
    assert.equal(json.data.name, 'Tester Actual');
    assert.equal(json.data.role, 'superuser');
    assert.equal(json.data.username, 'tester');
  } finally {
    db.query = originalQuery;
    server.close();
  }
});

test('GET /api/auth/me rechaza token válido de usuario inexistente', async () => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${buildToken({ userId: 999 })}` },
    });
    const json = await res.json();

    assert.equal(res.status, 401);
    assert.match(json.error, /sesión inválida/i);
  } finally {
    db.query = originalQuery;
    server.close();
  }
});

test('GET /api/auth/me rechaza token válido de usuario inactivo', async () => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [buildUserRow({ active: false })] });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 401);
    assert.match(json.error, /sesión inválida/i);
  } finally {
    db.query = originalQuery;
    server.close();
  }
});

test('GET /api/settings no ejecuta lógica de negocio cuando la sesión es inválida', async () => {
  const originalQuery = db.query;
  const originalGetTelegram = settingsService.getTelegram;
  let called = false;

  db.query = async () => ({ rows: [] });
  settingsService.getTelegram = async () => {
    called = true;
    return { token: '', chatId: '' };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${buildToken({ userId: 404 })}` },
    });
    const json = await res.json();

    assert.equal(res.status, 401);
    assert.match(json.error, /sesión inválida/i);
    assert.equal(called, false);
  } finally {
    db.query = originalQuery;
    settingsService.getTelegram = originalGetTelegram;
    server.close();
  }
});

test('POST /api/auth/login mantiene el contrato actual', async () => {
  const originalLogin = authService.login;
  authService.login = async () => ({
    token: 'signed-token',
    user: {
      id: 1,
      username: 'tester',
      name: 'Tester',
      role: 'user',
      active: true,
    },
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'secret123' }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.token, 'signed-token');
    assert.equal(json.data.user.username, 'tester');
  } finally {
    authService.login = originalLogin;
    server.close();
  }
});
