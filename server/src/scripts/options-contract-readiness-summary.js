/**
 * Sanitiza y clasifica un diagnóstico firmado de Binance Options.
 * Solo publica los nombres de controles y pass/fail/unverified.
 * "unverified" NO equivale a "ready": solo es admisible para getOrder
 * y userTrades cuando faltan antecedentes históricos.
 */
const REQUIRED = Object.freeze([
  'exchangeInfo', 'optionFilters', 'spotKlines1h', 'apiPermissions',
  'marginAccount', 'positions', 'openOrders', 'exerciseRecord',
  'bill', 'isolatedAccount', 'getOrder', 'userTrades',
]);

const SKIP_REASONS = Object.freeze({
  getOrder: new Set(['NO_HISTORICAL_ORDER']),
  userTrades: new Set(['NO_HISTORICAL_ORDER', 'NO_RECENT_TRADES']),
});

function summarizeReport(data) {
  if (!data || data.readOnly !== true || typeof data.ready !== 'boolean' ||
      !Array.isArray(data.results) || data.results.length !== REQUIRED.length) {
    throw new Error('Invalid contract report');
  }
  const expected = new Set(REQUIRED);
  const seen = new Set();
  let actualReady = true;
  let technicalFailure = false;
  let missingEvidence = false;
  const rows = [];

  for (const row of data.results) {
    if (!row || !expected.has(row.endpoint) || seen.has(row.endpoint) ||
        (row.ok !== true && row.ok !== false && row.ok !== null)) {
      throw new Error('Unexpected or duplicate endpoint');
    }
    seen.add(row.endpoint);
    if (row.ok !== true) actualReady = false;
    if (row.ok === false) technicalFailure = true;
    if (row.ok === null) {
      if (SKIP_REASONS[row.endpoint]?.has(row.skipped)) {
        missingEvidence = true;
      } else {
        technicalFailure = true;
      }
    }
    rows.push({
      endpoint: row.endpoint,
      status: row.ok === true ? 'pass' : row.ok === false ? 'fail' : 'unverified',
    });
  }

  if (seen.size !== expected.size || data.ready !== actualReady) {
    throw new Error('Inconsistent readiness');
  }

  const status = technicalFailure ? 'fail' : missingEvidence ? 'unverified' : 'pass';
  return { status, ready: actualReady, rows };
}

function formatSummary(result) {
  return [
    ...result.rows.map(row => `binance_${row.endpoint}=${row.status}`),
    `binance_contract_status=${result.status}`,
    `binance_contract_ready=${result.ready ? 'yes' : 'no'}`,
  ];
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', part => { raw += part; });
  process.stdin.on('end', () => {
    try {
      const result = summarizeReport(JSON.parse(raw));
      for (const line of formatSummary(result)) console.log(line);
      if (result.status === 'fail') process.exitCode = 2;
    } catch (_) {
      // No imprimir JSON, credenciales ni mensajes potencialmente sensibles.
      console.log('binance_contract_check=invalid_response');
      process.exitCode = 1;
    }
  });
}

module.exports = { REQUIRED, summarizeReport, formatSummary };
