const test = require('node:test');
const assert = require('node:assert/strict');

const TelegramService = require('../src/services/telegram.service');
const LpOrchestratorNotifier = require('../src/services/lp-orchestrator/notifier');
const orchestratorTag = require('../src/services/orchestrator-tag.service');

// Con varios orquestadores vivos, "Proteccion #19 | WETH/USDC" no dice cual
// tarjeta hay que abrir. El id del orquestador es lo unico que empareja la
// alerta con la UI, asi que tiene que viajar DENTRO del mensaje.

function buildCaptor({ tag = { id: 12, name: 'ETH agresivo' } } = {}) {
  const sent = [];
  const lookups = [];
  const svc = new TelegramService('token-falso', '123', {
    userId: 1,
    resolveOrchestratorTag: async (userId, protectedPoolId) => {
      lookups.push({ userId, protectedPoolId });
      return tag;
    },
  });
  svc.send = async (text, options) => { sent.push({ text, options }); return { ok: true }; };
  svc._resolvePrefs = async () => ({});
  return { svc, sent, lookups };
}

test('el bloqueo delta-neutral nombra al orquestador dueno de la proteccion', async () => {
  const { svc, sent, lookups } = buildCaptor();

  await svc.notifyDeltaNeutralBlock({
    protection: { id: 19, userId: 1, token0Symbol: 'WETH', token1Symbol: 'USDC', inferredAsset: 'ETH' },
    blockType: 'insufficient_margin',
    reason: 'sin margen',
  });

  assert.deepEqual(lookups, [{ userId: 1, protectedPoolId: 19 }]);
  assert.match(sent[0].text, /Orquestador: <b>#12 · ETH agresivo<\/b>/);
});

test('los eventos de cobertura arrastran el id via protectedPoolId', async () => {
  const hedge = { id: 7, asset: 'ETH', status: 'open', account: null, protectedPoolId: 19, direction: 'short', leverage: 3, entryPrice: 1, exitPrice: 2, size: 0.1 };

  for (const call of [
    (s) => s.notifyHedgeCreated(hedge),
    (s) => s.notifyHedgeOpened({ ...hedge, openPrice: 3000 }),
    (s) => s.notifyHedgeClosed({ ...hedge, openPrice: 3000, closePrice: 2900 }),
    (s) => s.notifyHedgeCancelled(hedge),
    (s) => s.notifyHedgeError(hedge, new Error('boom')),
    (s) => s.notifyHedgePartialCoverage(hedge, { expectedSize: 1, actualSize: 0.4, missingSize: 0.6 }),
  ]) {
    const { svc, sent } = buildCaptor();
    await call(svc);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Orquestador: <b>#12 · ETH agresivo<\/b>/);
  }
});

test('una cobertura manual (sin protected pool) no inventa orquestador', async () => {
  const { svc, sent, lookups } = buildCaptor();
  await svc.notifyHedgeCreated({ asset: 'BTC', direction: 'short', leverage: 3, entryPrice: 1, exitPrice: 2, size: 0.1 });
  assert.equal(lookups.length, 0, 'no debe consultar la BD sin protectedPoolId');
  assert.ok(!sent[0].text.includes('Orquestador'));
});

test('un LP orquestado que ya no existe no rompe el envio', async () => {
  const { svc, sent } = buildCaptor({ tag: null });
  await svc.notifyHedgeError({ id: 7, asset: 'ETH', status: 'open', account: null, protectedPoolId: 19 }, new Error('boom'));
  assert.equal(sent.length, 1, 'el mensaje sale igual, solo sin etiqueta');
  assert.ok(!sent[0].text.includes('Orquestador'));
});

test('sin resolutor inyectado el servicio no toca la BD', async () => {
  const sent = [];
  const svc = new TelegramService('token-falso', '123', { userId: 1 });
  svc.send = async (text) => { sent.push(text); return { ok: true }; };
  svc._resolvePrefs = async () => ({});
  await svc.notifyHedgeError({ id: 7, asset: 'ETH', status: 'open', account: null, protectedPoolId: 19 }, new Error('boom'));
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('Orquestador'));
});

test('el nombre del orquestador va escapado', async () => {
  const { svc, sent } = buildCaptor({ tag: { id: 3, name: 'A <b>&</b> B' } });
  await svc.notifyHedgeCancelled({ id: 7, asset: 'ETH', account: null, protectedPoolId: 19 });
  assert.match(sent[0].text, /#3 · A &lt;b&gt;&amp;&lt;\/b&gt; B/);
});

test('el encabezado del orquestador antepone su id al nombre', async () => {
  const sent = [];
  const notifier = new LpOrchestratorNotifier({
    telegramRegistry: { getOrCreate: async () => ({ enabled: true, send: async (t) => sent.push(t) }) },
    logger: { warn() {} },
  });

  await notifier.lpKilled({
    id: 12, userId: 1, name: 'ETH agresivo',
    token0Symbol: 'WETH', token1Symbol: 'USDC', network: 'arbitrum', version: 'v3',
  });

  assert.match(sent[0], /🎛 #12 · ETH agresivo/);
});

test('resolveByProtectedPoolId cachea y no reconsulta por cada mensaje', async () => {
  orchestratorTag.clearCache();
  let calls = 0;
  const repository = {
    async findIdentityByProtectedPoolId(userId, poolId) {
      calls += 1;
      return { id: 12, name: `pool-${poolId}` };
    },
  };
  const first = await orchestratorTag.resolveByProtectedPoolId(1, 19, { repository });
  const second = await orchestratorTag.resolveByProtectedPoolId(1, 19, { repository });
  assert.deepEqual(first, second);
  assert.equal(calls, 1);

  orchestratorTag.invalidate(1, 19);
  await orchestratorTag.resolveByProtectedPoolId(1, 19, { repository });
  assert.equal(calls, 2, 'invalidar fuerza una consulta nueva');
  orchestratorTag.clearCache();
});

test('un fallo de la BD no propaga: el mensaje sale sin etiqueta', async () => {
  orchestratorTag.clearCache();
  const repository = {
    async findIdentityByProtectedPoolId() { throw new Error('db caida'); },
  };
  const tag = await orchestratorTag.resolveByProtectedPoolId(1, 19, { repository });
  assert.equal(tag, null);
  orchestratorTag.clearCache();
});
