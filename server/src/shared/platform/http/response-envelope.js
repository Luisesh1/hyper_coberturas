function buildSuccessEnvelope(data, meta = null) {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
  };
}

function buildErrorEnvelope({
  message,
  code = 'UNHANDLED_ERROR',
  requestId = null,
  details = null,
  stack = null,
}) {
  const errorInfo = {
    code,
    message,
    ...(details ? { details } : {}),
    ...(requestId ? { requestId } : {}),
  };

  return {
    success: false,
    error: message,
    code,
    errorInfo,
    ...(requestId ? { requestId } : {}),
    ...(details ? { details } : {}),
    ...(stack ? { stack } : {}),
  };
}

module.exports = {
  buildSuccessEnvelope,
  buildErrorEnvelope,
};
