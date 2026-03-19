const logger = require('./logger.service');
const backtestingService = require('./backtesting.service');

const jobs = new Map();
let processing = false;
const queue = [];
let nextJobId = 1;

const JOB_TTL_MS = 30 * 60 * 1000; // 30 min
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function generateJobId() {
  return `bt-${Date.now()}-${nextJobId++}`;
}

function enqueue(userId, input) {
  const userJobs = [...queue, ...Array.from(jobs.values())]
    .filter((j) => j.userId === userId && (j.status === 'pending' || j.status === 'running'));
  if (userJobs.length >= 3) {
    throw Object.assign(new Error('Maximo 3 backtests en cola por usuario'), { statusCode: 429 });
  }

  const jobId = generateJobId();
  const job = {
    id: jobId,
    userId,
    input,
    status: 'pending',
    result: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  jobs.set(jobId, job);
  queue.push(job);
  logger.info('backtest_job_enqueued', { jobId, userId, queueSize: queue.length });
  processNext();
  return { jobId, position: queue.length };
}

async function processNext() {
  if (processing || queue.length === 0) return;

  const job = queue.shift();
  if (!job || job.status !== 'pending') {
    processNext();
    return;
  }

  processing = true;
  job.status = 'running';
  job.startedAt = Date.now();
  logger.info('backtest_job_started', { jobId: job.id, userId: job.userId });

  try {
    const result = await backtestingService.simulateBacktest(job.userId, job.input, { timeoutMs: 120_000 });
    job.status = 'completed';
    job.result = result;
    job.completedAt = Date.now();
    const durationSec = ((job.completedAt - job.startedAt) / 1000).toFixed(1);
    logger.info('backtest_job_completed', {
      jobId: job.id,
      userId: job.userId,
      trades: result.metrics?.trades || 0,
      durationSec,
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || 'Error desconocido';
    job.completedAt = Date.now();
    logger.warn('backtest_job_failed', { jobId: job.id, error: job.error });
  } finally {
    processing = false;
    processNext();
  }
}

function getJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  return sanitizeJob(job);
}

function getUserJobs(userId) {
  return Array.from(jobs.values())
    .filter((j) => j.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(sanitizeJob);
}

function sanitizeJob(job) {
  const base = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    asset: job.input?.asset || '',
    timeframe: job.input?.timeframe || '',
    strategyId: job.input?.strategyId || null,
  };
  if (job.status === 'completed') base.result = job.result;
  if (job.status === 'failed') base.error = job.error;
  return base;
}

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.completedAt && now - job.completedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

let cleanupTimer = null;

function start() {
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
}

function stop() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = { enqueue, getJob, getUserJobs, start, stop };
