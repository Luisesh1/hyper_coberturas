const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ValidationError } = require('../errors/app-error');

const WORKER_PATH = path.join(__dirname, 'strategy-engine.worker.js');
const DEFAULT_TIMEOUT_MS = 1_500;

function runWorker(payload, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH);
    const timer = setTimeout(async () => {
      await worker.terminate().catch(() => {});
      reject(new ValidationError('La ejecución del script excedió el timeout permitido'));
    }, timeout + 250);

    worker.once('message', async (message) => {
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      if (!message.ok) {
        reject(new ValidationError(message.error?.message || 'Error al ejecutar script'));
        return;
      }
      resolve(message.result);
    });

    worker.once('error', async (error) => {
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      reject(error);
    });

    worker.postMessage({ ...payload, timeout });
  });
}

async function validateStrategy({ source, context, customIndicators = [] }) {
  return runWorker({
    type: 'validate',
    source,
    context,
    customIndicators,
  });
}

async function backtestStrategy({ source, baseContext, customIndicators = [], tradeSize }) {
  return runWorker({
    type: 'backtest',
    source,
    baseContext,
    customIndicators,
    tradeSize,
  }, { timeout: 5_000 });
}

async function simulateBacktest({
  source,
  baseContext,
  customIndicators = [],
  sizingMode = 'usd',
  sizeUsd,
  tradeSize,
  leverage,
  marginMode,
  stopLossPct,
  takeProfitPct,
  feeBps,
  slippageBps,
  overlayRequests = [],
}) {
  return runWorker({
    type: 'backtest',
    source,
    baseContext,
    customIndicators,
    sizingMode,
    sizeUsd,
    tradeSize,
    leverage,
    marginMode,
    stopLossPct,
    takeProfitPct,
    feeBps,
    slippageBps,
    overlayRequests,
  }, { timeout: 8_000 });
}

async function validateIndicator({ slug, source, input, params }) {
  return runWorker({
    type: 'indicator',
    slug,
    source,
    input,
    params,
  });
}

module.exports = {
  backtestStrategy,
  simulateBacktest,
  validateIndicator,
  validateStrategy,
};
