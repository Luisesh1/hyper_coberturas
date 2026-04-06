const httpClient = require('../shared/platform/http/http-client');
const config = require('../config');
const logger = require('./logger.service');
const { ExternalServiceError, ValidationError } = require('../errors/app-error');

const ETHERSCAN_API_URL = 'https://api.etherscan.io/v2/api';
const MAX_RATE_LIMIT_RETRIES = 60;

function normalizeEtherscanError(result) {
  const message = String(result?.result || result?.message || 'Error desconocido');
  const lowered = message.toLowerCase();
  if (
    lowered.includes('invalid api key')
    || lowered.includes('missing or unsupported chainid')
    || lowered.includes('unauthorized')
    || lowered.includes('invalid key')
  ) {
    throw new ValidationError('Etherscan API key invalida o sin permisos para esta red');
  }
  if (lowered.includes('max rate limit')) {
    throw new ExternalServiceError('Etherscan rate limit excedido');
  }
  throw new ExternalServiceError(`Etherscan error: ${message}`);
}

function createEtherscanQueueClient({
  axiosInstance = httpClient,
  apiUrl = ETHERSCAN_API_URL,
  timeoutMs = config.uniswap.scanTimeoutMs,
  maxRequestsPerSecond = 3,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  queueLogger = logger,
} = {}) {
  const pending = [];
  const dispatchTimestamps = [];
  let timer = null;

  const cleanupDispatchTimestamps = () => {
    const threshold = now() - 1000;
    while (dispatchTimestamps.length > 0 && dispatchTimestamps[0] <= threshold) {
      dispatchTimestamps.shift();
    }
  };

  const schedule = () => {
    if (timer || pending.length === 0) return;
    cleanupDispatchTimestamps();

    if (dispatchTimestamps.length < maxRequestsPerSecond) {
      timer = setTimer(() => {
        timer = null;
        processQueue();
      }, 0);
      return;
    }

    const waitMs = Math.max(0, 1000 - (now() - dispatchTimestamps[0]));
    timer = setTimer(() => {
      timer = null;
      processQueue();
    }, waitMs);
  };

  const execute = async (job) => {
    const startedAt = now();
    try {
      const { data } = await axiosInstance.get(apiUrl, {
        params: {
          ...job.params,
          apikey: job.apiKey,
        },
        timeout: job.timeoutMs,
      });

      if (data?.status === '1') {
        queueLogger.info('etherscan_queue_request_completed', {
          module: job.params?.module || null,
          action: job.params?.action || null,
          queueSizeAtEnqueue: job.queueSizeAtEnqueue,
          waitMs: startedAt - job.enqueuedAt,
          durationMs: now() - startedAt,
          rateLimitedHits: job.rateLimitedHits,
        });
        job.resolve(data.result);
        return;
      }

      const noResults =
        (job.params?.action === 'txlist' || job.params?.action === 'tokennfttx')
        && data?.status === '0'
        && (
          String(data?.message || '').toLowerCase().includes('no transactions')
          || String(data?.result || '').toLowerCase().includes('no transactions')
        );

      if (noResults) {
        queueLogger.info('etherscan_queue_request_completed', {
          module: job.params?.module || null,
          action: job.params?.action || null,
          queueSizeAtEnqueue: job.queueSizeAtEnqueue,
          waitMs: startedAt - job.enqueuedAt,
          durationMs: now() - startedAt,
          rateLimitedHits: job.rateLimitedHits,
        });
        job.resolve([]);
        return;
      }

      normalizeEtherscanError(data);
    } catch (err) {
      const error = err instanceof ValidationError || err instanceof ExternalServiceError
        ? err
        : new ExternalServiceError(`Etherscan request fallo: ${err.message}`);
      queueLogger.warn('etherscan_queue_request_failed', {
        module: job.params?.module || null,
        action: job.params?.action || null,
        queueSizeAtEnqueue: job.queueSizeAtEnqueue,
        waitMs: startedAt - job.enqueuedAt,
        durationMs: now() - startedAt,
        rateLimitedHits: job.rateLimitedHits,
        error: error.message,
      });
      job.reject(error);
    }
  };

  const processQueue = () => {
    cleanupDispatchTimestamps();
    while (pending.length > 0 && dispatchTimestamps.length < maxRequestsPerSecond) {
      const job = pending.shift();
      dispatchTimestamps.push(now());
      void execute(job);
      cleanupDispatchTimestamps();
    }

    if (pending.length > 0) {
      if (pending[0].rateLimitedHits >= MAX_RATE_LIMIT_RETRIES) {
        const job = pending.shift();
        job.reject(new ExternalServiceError('Etherscan timeout: demasiados reintentos por rate limit'));
      } else {
        pending[0].rateLimitedHits += 1;
      }
      schedule();
    }
  };

  return {
    async request(apiKey, params, { requestTimeoutMs = timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        pending.push({
          apiKey,
          params,
          timeoutMs: requestTimeoutMs,
          resolve,
          reject,
          enqueuedAt: now(),
          queueSizeAtEnqueue: pending.length,
          rateLimitedHits: 0,
        });
        schedule();
      });
    },
    getPendingCount() {
      return pending.length;
    },
    shutdown() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

const sharedClient = createEtherscanQueueClient();

module.exports = {
  createEtherscanQueueClient,
  request: sharedClient.request.bind(sharedClient),
  shutdown: sharedClient.shutdown.bind(sharedClient),
};
