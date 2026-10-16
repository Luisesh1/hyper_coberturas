const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const flow = fs.readFileSync(path.resolve(
  __dirname, '../../.github/workflows/options-pilot-preflight.yml'), 'utf8');
const script = fs.readFileSync(path.resolve(
  __dirname, '../src/scripts/options-pilot-preflight.js'), 'utf8');

test('preflight ETH solo manual con host SSH fijado y salida minimizada', () => {
  assert.match(flow, /workflow_dispatch:/);
  assert.match(flow, /binance_user_id:/);
  assert.match(flow, /environment: production/);
  assert.match(flow, /permissions:\s*\n\s+contents: read/);
  assert.match(flow, /SERVER_SSH_KNOWN_HOSTS/);
  assert.match(flow, /StrictHostKeyChecking=yes/);
  assert.match(flow, /ssh-keygen -F/);
  assert.match(flow, /pilot_ready=no/);
  assert.match(flow, /pilot_technical_status=pass/);
  assert.match(flow, /pilot_liveFlagsOff=pass/);
  assert.match(flow, /pilot_isolatedAccount=pass/);
  assert.doesNotMatch(flow, /ssh-keyscan|docker compose.*up -d|npm run migrate/);
  assert.doesNotMatch(flow, /getSecret|echo "\$BINANCE_USER_ID"/);
});

test('el script es siempre solo lectura y nunca puede ser autorización', () => {
  assert.match(script, /pilotReady: false/);
  assert.match(script, /readOnly: true/);
  assert.match(script, /chosenContract/);
  assert.match(script, /operatorApproval/);
  assert.match(script, /OPTIONS_LIVE_TRADING_ENABLED === 'false'/);
  assert.match(script, /OPTIONS_LIVE_PRODUCTION_APPROVED === 'false'/);
  assert.doesNotMatch(script, /\.placeOrder\(|\.cancelOrder\(|\.query\(/);
});
