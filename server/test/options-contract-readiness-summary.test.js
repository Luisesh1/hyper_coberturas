const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED, summarizeReport, formatSummary } =
  require('../src/scripts/options-contract-readiness-summary');

function report(overrides = {}) {
  const rows = REQUIRED.map(endpoint => ({ endpoint, ok: true }));
  for (const [endpoint, values] of Object.entries(overrides)) {
    const item = rows.find(row => row.endpoint === endpoint);
    if (item) Object.assign(item, values);
  }
  return { readOnly: true, ready: rows.every(row => row.ok === true), results: rows };
}

test('todos pass produce pass y ready yes', () => {
  const result = summarizeReport(report());
  assert.equal(result.status, 'pass');
  assert.equal(result.ready, true);
  assert.match(formatSummary(result).join('\n'), /binance_contract_ready=yes/);
});

test('sin órdenes históricas: unverified, ready no, sin fallo técnico', () => {
  const result = summarizeReport(report({
    getOrder: { ok: null, skipped: 'NO_HISTORICAL_ORDER' },
    userTrades: { ok: null, skipped: 'NO_HISTORICAL_ORDER' },
  }));
  assert.equal(result.status, 'unverified');
  assert.equal(result.ready, false);
  assert.match(formatSummary(result).join('\n'), /binance_contract_ready=no/);
  assert.match(formatSummary(result).join('\n'), /binance_contract_status=unverified/);
});

test('sin fills recientes también queda unverified', () => {
  const result = summarizeReport(report({
    userTrades: { ok: null, skipped: 'NO_RECENT_TRADES' },
  }));
  assert.equal(result.status, 'unverified');
});

test('cualquier control fallido es fail aunque falte evidencia histórica', () => {
  const result = summarizeReport(report({
    apiPermissions: { ok: false },
    getOrder: { ok: null, skipped: 'NO_HISTORICAL_ORDER' },
    userTrades: { ok: null, skipped: 'NO_HISTORICAL_ORDER' },
  }));
  assert.equal(result.status, 'fail');
  assert.equal(result.ready, false);
});

test('unverified de permiso sensible se clasifica fail, nunca éxito', () => {
  const result = summarizeReport(report({
    apiPermissions: { ok: null, skipped: 'NO_HISTORICAL_ORDER' },
  }));
  assert.equal(result.status, 'fail');
});

test('reporte mal formado o listo de forma inconsistente se rechaza', () => {
  const r = report();
  assert.throws(() => summarizeReport({ ...r, readOnly: false }));
  assert.throws(() => summarizeReport({ ...r, ready: false }));
  assert.throws(() => summarizeReport({ ...r, results: r.results.slice(1) }));
  assert.throws(() => summarizeReport({ ...r, results: [...r.results.slice(1), r.results[1]] }));
  const unknownSkip = report({ getOrder: { ok: null, skipped: 'UNKNOWN' } });
  assert.equal(summarizeReport(unknownSkip).status, 'fail');
});

test('salida minimizada no contiene saldos ni identificadores privados', () => {
  const r = report();
  r.results[0].balance = 'SECRET_BALANCE';
  r.results[0].symbol = 'SECRET_SYMBOL';
  const output = formatSummary(summarizeReport(r)).join('\n');
  assert.doesNotMatch(output, /SECRET_BALANCE|SECRET_SYMBOL/);
});
