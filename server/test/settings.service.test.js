const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SETTINGS_ENCRYPTION_KEY = 'test-settings-key';

const {
  ENCRYPTED_PREFIX,
  decryptValue,
  encryptJson,
  normalizeChartIndicators,
  getDefaultChartIndicators,
  normalizeChartDrawingsAll,
  normalizeDrawingEntry,
} = require('../src/services/settings.service');

test('encryptJson cifra payload sensible', () => {
  const encrypted = encryptJson({ privateKey: '0xabc', address: '0x123' });

  assert.ok(encrypted.startsWith(ENCRYPTED_PREFIX));
  assert.notEqual(encrypted.includes('0xabc'), true);
});

test('decryptValue soporta payload cifrado', () => {
  const input = { token: 'abc', chatId: '123' };
  const encrypted = encryptJson(input);

  assert.deepEqual(decryptValue(encrypted), input);
});

test('decryptValue mantiene compatibilidad con JSON plano legado', () => {
  const plain = JSON.stringify({ address: '0xlegacy' });
  assert.deepEqual(decryptValue(plain), { address: '0xlegacy' });
});

test('getDefaultChartIndicators incluye SQZMOM activo por defecto', () => {
  const defaults = getDefaultChartIndicators();
  assert.equal(defaults.version, 1);
  assert.equal(defaults.indicators.length, 1);
  assert.equal(defaults.indicators[0].type, 'sqzmom');
  assert.equal(defaults.indicators[0].visible, true);
});

test('normalizeChartIndicators preserva entradas válidas y descarta tipos desconocidos', () => {
  const input = {
    indicators: [
      { uid: 'a', type: 'ema', params: { length: 20 }, style: { color: '#ff0000' }, visible: true },
      { uid: 'b', type: 'foobar', params: {} },
      { uid: 'c', type: 'rsi', params: { length: 14 } },
    ],
  };
  const out = normalizeChartIndicators(input);
  assert.equal(out.indicators.length, 2);
  assert.deepEqual(out.indicators.map((i) => i.type), ['ema', 'rsi']);
  assert.equal(out.indicators[0].style.color, '#ff0000');
});

test('normalizeChartIndicators rechaza params no numéricos/booleanos', () => {
  const out = normalizeChartIndicators({
    indicators: [{ uid: 'x', type: 'ema', params: { length: 20, junk: { nested: true }, useTrueRange: true } }],
  });
  assert.deepEqual(out.indicators[0].params, { length: 20, useTrueRange: true });
});

test('normalizeChartIndicators rechaza colores inválidos', () => {
  const out = normalizeChartIndicators({
    indicators: [{ uid: 'x', type: 'ema', params: {}, style: { color: 'javascript:alert(1)', lineWidth: 2 } }],
  });
  assert.equal(out.indicators[0].style.color, undefined);
  assert.equal(out.indicators[0].style.lineWidth, 2);
});

test('normalizeChartIndicators limita a 20 indicadores', () => {
  const many = {
    indicators: Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, type: 'ema', params: { length: 10 } })),
  };
  const out = normalizeChartIndicators(many);
  assert.equal(out.indicators.length, 20);
});

test('normalizeChartIndicators con valor nulo/invalido devuelve defaults', () => {
  const out = normalizeChartIndicators(null);
  assert.equal(out.indicators.length, 1);
  assert.equal(out.indicators[0].type, 'sqzmom');
});

// ------------------------------------------------------------------
// Chart drawings
// ------------------------------------------------------------------

test('normalizeDrawingEntry acepta trendline válido', () => {
  const entry = normalizeDrawingEntry({
    uid: 'tl-1',
    type: 'trendline',
    anchors: [{ time: 1700000000, price: 3000 }, { time: 1700100000, price: 3500 }],
    style: { color: '#60a5fa', lineWidth: 2 },
  });
  assert.ok(entry);
  assert.equal(entry.type, 'trendline');
  assert.equal(entry.anchors.length, 2);
  assert.equal(entry.style.color, '#60a5fa');
});

test('normalizeDrawingEntry rechaza horizontal sin price', () => {
  const bad = normalizeDrawingEntry({
    uid: 'h-1',
    type: 'horizontal',
    anchors: [{ time: 123 }], // falta price
  });
  assert.equal(bad, null);
});

test('normalizeDrawingEntry rechaza tipo desconocido', () => {
  assert.equal(normalizeDrawingEntry({ type: 'foobar', anchors: [] }), null);
});

test('normalizeDrawingEntry rechaza trendline con un solo anchor', () => {
  const bad = normalizeDrawingEntry({
    type: 'trendline',
    anchors: [{ time: 1700000000, price: 3000 }],
  });
  assert.equal(bad, null);
});

test('normalizeDrawingEntry rechaza fib con anchors sin time', () => {
  const bad = normalizeDrawingEntry({
    type: 'fib',
    anchors: [{ price: 100 }, { price: 200 }],
  });
  assert.equal(bad, null);
});

test('normalizeDrawingEntry rechaza color inválido', () => {
  const entry = normalizeDrawingEntry({
    type: 'horizontal',
    anchors: [{ price: 100 }],
    style: { color: 'javascript:alert(1)' },
  });
  assert.ok(entry);
  assert.equal(entry.style.color, undefined);
});

test('normalizeChartDrawingsAll ignora símbolos con caracteres raros', () => {
  const out = normalizeChartDrawingsAll({
    bySymbol: {
      ETH: [{ type: 'horizontal', anchors: [{ price: 100 }] }],
      'bad symbol!': [{ type: 'horizontal', anchors: [{ price: 100 }] }],
    },
  });
  assert.ok(out.bySymbol.ETH);
  assert.equal(out.bySymbol['bad symbol!'], undefined);
});

test('normalizeChartDrawingsAll limita a 50 por símbolo', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    uid: `u${i}`,
    type: 'horizontal',
    anchors: [{ price: 100 + i }],
  }));
  const out = normalizeChartDrawingsAll({ bySymbol: { ETH: many } });
  assert.equal(out.bySymbol.ETH.length, 50);
});

test('normalizeChartDrawingsAll descarta símbolos vacíos', () => {
  const out = normalizeChartDrawingsAll({
    bySymbol: {
      ETH: [{ type: 'horizontal', anchors: [{ price: 100 }] }],
      BTC: [],
    },
  });
  assert.ok(out.bySymbol.ETH);
  assert.equal(out.bySymbol.BTC, undefined);
});
