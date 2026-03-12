const config = require('../config');
const { ConfigError } = require('../errors/app-error');

const INSECURE_JWT_VALUES = new Set([
  '',
  'changeme-use-a-strong-secret-in-production',
  'dev-secret-change-in-production',
  'change-me-in-production',
  'your_jwt_secret_here',
]);

function bootstrapConfig() {
  if (config.server.nodeEnv === 'production') {
    if (INSECURE_JWT_VALUES.has(config.jwt.secret)) {
      throw new ConfigError('JWT_SECRET inseguro o ausente en producción');
    }
    if (!config.security.settingsEncryptionKey) {
      throw new ConfigError('SETTINGS_ENCRYPTION_KEY es obligatoria en producción');
    }
  }

  return config;
}

module.exports = { bootstrapConfig };
