// Lazy require para evitar ciclo: dev-log-sink importa config, config no
// importa logger, pero dev-log-sink podría querer loguear su propio init.
// Cargamos perezoso por si acaso.
let _devLogSink = null;
function getDevLogSink() {
  if (_devLogSink !== null) return _devLogSink;
  try {
    _devLogSink = require('./dev-log-sink.service');
  } catch {
    _devLogSink = { isEnabled: () => false, publish: () => null };
  }
  return _devLogSink;
}

function log(level, message, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Alimentar el sink in-memory de dev solo para warn/error (filtro de
  // profundidad: errores y warnings, sin info ruidosa). En producción
  // isEnabled() devuelve false → no-op.
  if (level === 'warn' || level === 'error') {
    const sink = getDevLogSink();
    if (sink.isEnabled()) {
      sink.publish({
        ...payload,
        source: meta?.source || 'server',
      });
    }
  }
}

module.exports = {
  info(message, meta) {
    log('info', message, meta);
  },
  warn(message, meta) {
    log('warn', message, meta);
  },
  error(message, meta) {
    log('error', message, meta);
  },
};
