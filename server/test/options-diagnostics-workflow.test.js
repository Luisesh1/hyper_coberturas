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

const deployWorkflow = fs.readFileSync(path.resolve(
  __dirname, '../../.github/workflows/deploy.yml'), 'utf8');

test('despliegue protegido: SSH no confía en una huella obtenida durante el job', () => {
  assert.match(deployWorkflow, /SERVER_SSH_KNOWN_HOSTS/);
  assert.match(deployWorkflow, /ssh-keygen -F/);
  assert.match(deployWorkflow, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(deployWorkflow, /ssh-keyscan/);
});

const productionCompose = fs.readFileSync(path.resolve(
  __dirname, '../../docker-compose.prod.yml'), 'utf8');

test('pilot deployment forces both Binance Options live flags off regardless of server/.env', () => {
  assert.match(productionCompose, /OPTIONS_LIVE_TRADING_ENABLED:\s*["']false["']/);
  assert.match(productionCompose, /OPTIONS_LIVE_PRODUCTION_APPROVED:\s*["']false["']/);
});

test('deployment stops before checkout and build when production trading is active', () => {
  const gate = deployWorkflow.indexOf('Preflight VPS - bloquear deploy');
  const actualDeploy = deployWorkflow.indexOf('Deploy por SSH');
  assert.ok(gate >= 0 && actualDeploy > gate, 'preflight precedes deployment');
  assert.match(deployWorkflow, /OPTIONS_LIVE_TRADING_ENABLED ===/);
  assert.match(deployWorkflow, /OPTIONS_LIVE_PRODUCTION_APPROVED ===/);
  assert.match(deployWorkflow, /options_predeploy_gate=pass/);
  assert.match(deployWorkflow, /options_deployed_read_only=pass/);
  assert.match(deployWorkflow, /options-live-contract-check\.js/);
  assert.match(deployWorkflow, /git rev-parse HEAD/);
});
