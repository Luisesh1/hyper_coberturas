const test = require('node:test');
const assert = require('node:assert/strict');

const TelegramService = require('../src/services/telegram.service');
const { describeTelegramError } = require('../src/services/external-service-helpers');

const { escapeHtml } = TelegramService;

// Construye un servicio que NO sale a la red: captura el texto que habria
// enviado. `enabled` exige token y chatId, asi que se pasan falsos.
function buildCaptor() {
  const sent = [];
  const svc = new TelegramService('token-falso', '123', { userId: 1 });
  svc.send = async (text, options) => { sent.push({ text, options }); return { ok: true }; };
  svc._resolvePrefs = async () => ({});
  return { svc, sent };
}

test('escapeHtml neutraliza los tres caracteres que rompen el parser', () => {
  assert.equal(escapeHtml('a < b'), 'a &lt; b');
  assert.equal(escapeHtml('a > b'), 'a &gt; b');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  // El & se escapa PRIMERO: al reves, el &lt; recien creado se volveria
  // &amp;lt; y el mensaje mostraria basura.
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('el motivo real que dejo mudo al canal ya no rompe el HTML', async () => {
  // Cadena EXACTA que arma `execution.js` en la rama below_min_order_notional.
  // Telegram respondia: can't parse entities: Unsupported start tag "" at byte
  // offset 127 — y el mensaje nunca llegaba.
  const reason = 'Drift $2.99 < minimo $11';
  const { svc, sent } = buildCaptor();

  await svc.notifyDeltaNeutralBlock({
    protection: { id: 19, userId: 1, token0Symbol: 'WETH', token1Symbol: 'USDC', inferredAsset: 'ETH' },
    blockType: 'below_min_order_notional',
    reason,
    extra: { driftUsd: 2.99, minNotionalUsd: 11 },
  });

  assert.equal(sent.length, 1, 'tiene que haber intentado enviar');
  const { text } = sent[0];
  assert.ok(text.includes('Motivo: Drift $2.99 &lt; minimo $11'), 'el motivo va escapado');
  // Ni un `<` suelto: todo `<` que quede tiene que abrir una etiqueta conocida.
  for (const m of text.matchAll(/<(\/?)([a-zA-Z]*)/g)) {
    assert.ok(['b', 'i', 'a', 'code', 'pre', 'u', 's'].includes(m[2]),
      `etiqueta inesperada "${m[2]}" — es texto libre sin escapar`);
  }
});

test('un detalle con < > & tampoco escapa al template', async () => {
  const { svc, sent } = buildCaptor();
  await svc.notifyDeltaNeutralBlock({
    protection: { id: 1, userId: 1, token0Symbol: 'A<b>', token1Symbol: 'B&C', inferredAsset: 'E<T>H' },
    blockType: 'insufficient_margin',
    reason: 'x < y',
    detail: 'Orden rechazada: a & b > c',
    extra: { cooldownReason: 'i < j', positionReadSource: 'p&q' },
  });
  const { text } = sent[0];
  for (const frag of ['x &lt; y', 'a &amp; b &gt; c', 'i &lt; j', 'p&amp;q', 'A&lt;b&gt;', 'B&amp;C', 'E&lt;T&gt;H']) {
    assert.ok(text.includes(frag), `falta escapado: ${frag}`);
  }
});

test('el error de cobertura escapa el mensaje de la excepcion', async () => {
  const { svc, sent } = buildCaptor();
  await svc.notifyHedgeError(
    { id: 7, asset: 'ETH', status: 'open', account: null },
    new Error('size < min && precio > techo'),
  );
  assert.ok(sent[0].text.includes('size &lt; min &amp;&amp; precio &gt; techo'));
});

test('describeTelegramError rescata la causa real que axios esconde', () => {
  const err = {
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: { ok: false, error_code: 400, description: 'Bad Request: can\'t parse entities' },
    },
  };
  const d = describeTelegramError(err);
  assert.equal(d.status, 400);
  assert.equal(d.errorCode, 400);
  assert.equal(d.description, 'Bad Request: can\'t parse entities');
  // Sin respuesta no inventa nada.
  const vacio = describeTelegramError(new Error('socket hang up'));
  assert.equal(vacio.description, null);
  assert.equal(vacio.errorCode, null);
});
