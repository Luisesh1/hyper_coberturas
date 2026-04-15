function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(baseMs, jitterMs = 0) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (!Number.isFinite(jitterMs) || jitterMs <= 0) return Math.round(baseMs);
  return Math.round(baseMs + Math.random() * jitterMs);
}

function computeBackoffMs(attempt, {
  baseMs = 250,
  capMs = 5_000,
  jitterMs = 100,
} = {}) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const unclamped = baseMs * (2 ** safeAttempt);
  return withJitter(Math.min(capMs, unclamped), jitterMs);
}

function parseRetryAfterMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 1000);
}

function extractTelegramRetryAfterMs(err) {
  return parseRetryAfterMs(err?.response?.data?.parameters?.retry_after);
}

function messageIncludes(err, ...patterns) {
  const message = String(
    err?.response?.data?.message
    || err?.response?.data?.error
    || err?.response?.data?.description
    || err?.message
    || ''
  ).toLowerCase();
  return patterns.some((pattern) => message.includes(String(pattern).toLowerCase()));
}

function isTelegramRetryableError(err) {
  const status = Number(err?.response?.status || 0);
  return status === 429
    || status >= 500
    || messageIncludes(err, 'too many requests', 'flood control', 'timeout', 'socket hang up');
}

function isAlchemyRateLimitError(err) {
  const status = Number(err?.response?.status || 0);
  return status === 429
    || messageIncludes(
      err,
      'compute units per second capacity',
      'concurrent requests capacity',
      'rate limit',
      'too many requests',
      'throughput',
      'backoff_seconds'
    );
}

function isHyperliquidRetryableError(err) {
  const status = Number(err?.response?.status || 0);
  return status === 429
    || status >= 500
    || messageIncludes(
      err,
      'rate limit',
      'too many requests',
      'service unavailable',
      'temporarily unavailable',
      'timeout',
      'econnreset',
      'socket hang up'
    );
}

module.exports = {
  sleep,
  withJitter,
  computeBackoffMs,
  parseRetryAfterMs,
  extractTelegramRetryAfterMs,
  isTelegramRetryableError,
  isAlchemyRateLimitError,
  isHyperliquidRetryableError,
};
