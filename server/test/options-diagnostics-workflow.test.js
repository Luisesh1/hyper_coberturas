const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.resolve(
  __dirname, '../../.github/workflows/options-diagnostics.yml'), 'utf8');

test('workflow de diagnóstico cinco horas: solo lectura con host SSH fijado', () => {
  assert.match(workflow, /cron:\s*'17 \*\/5 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /SERVER_SSH_KNOWN_HOSTS/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /ssh-keygen -F/);
  assert.doesNotMatch(workflow, /^\s*ssh-keyscan\b/m);
  assert.doesNotMatch(workflow, /^\s*(curl|wget|ssh)\s+.*POST\b/m);
  assert.match(workflow, /options-live-audit\.js/);
  assert.match(workflow, /options_attention_orders=/);
  assert.match(workflow, /options_expired_positions=/);
  assert.match(workflow, /audit=invalid_response/);
});

test('manual Binance contract check is read-only, fail-closed and never exposes raw JSON', () => {
  assert.match(workflow, /binance_user_id:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /OPTIONS_LIVE_TRADING_ENABLED/);
  assert.match(workflow, /OPTIONS_LIVE_PRODUCTION_APPROVED/);
  assert.match(workflow, /options-live-contract-check\.js/);
  assert.match(workflow, /binance_contract_check=not_deployed/);
  assert.match(workflow, /binance_contract_ready=/);
  assert.match(workflow, /result\.readOnly !== true/);
  assert.match(workflow, /row\.endpoint/);
  assert.doesNotMatch(workflow, /echo "\$raw"/);
  assert.doesNotMatch(workflow, /git checkout|docker compose .*up -d|npm run migrate/);
});
