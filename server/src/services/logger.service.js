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

// ──────────────────────────────────────────────────────────────────
// Redacción de secretos en logs.
// Cubre: claves privadas EVM (`0x` + 64 hex), firmas, JWT, y campos
// sensibles por nombre. Se aplica recursivamente sobre el meta antes
// de serializar. Ante un fallo de redacción, retornamos el original
// (no queremos tirar logs por un bug en el redactor).
// ──────────────────────────────────────────────────────────────────
const SENSITIVE_KEY_RE = /^(?:authorization|cookie|set-cookie|password|password_hash|jwt|token|access_token|refresh_token|private_key|privatekey|seed|mnemonic|signature|sig|settings_encryption_key|encryption_key|api_key|api_secret|secret|session)$/i;
// `0x` + 64 hex (claves/firmas canónicas) y `0x` + 128/130 hex (sigs).
const HEX_SECRET_RE = /0x[a-fA-F0-9]{64}(?:[a-fA-F0-9]{2})?(?:[a-fA-F0-9]{64})?/g;
// Bearer tokens y JWTs comunes
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/g;

const REDACTED = '[REDACTED]';

function redactString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(HEX_SECRET_RE, REDACTED)
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(JWT_RE, REDACTED);
}

function redact(input, depth = 0) {
  if (input == null) return input;
  if (depth > 6) return input; // corte defensivo contra ciclos/profundidad
  const type = typeof input;
  if (type === 'string') return redactString(input);
  if (type !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function log(level, message, meta = {}) {
  let safeMeta = meta;
  try {
    safeMeta = redact(meta);
  } catch {
    // fallback: nunca bloqueamos un log por error de redacción
  }
  const payload = {
    ts: new Date().toISOString(),
    level,
    message: typeof message === 'string' ? redactString(message) : message,
    ...safeMeta,
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
  // Expuestos para tests unitarios.
  _internal: { redact, redactString },
};
