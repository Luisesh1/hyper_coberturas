require('dotenv').config();

// ------------------------------------------------------------------
// Valores inseguros que NUNCA deben usarse en producción
// ------------------------------------------------------------------
const INSECURE_VALUES = new Set([
  'changeme-use-a-strong-secret-in-production',
  'dev-secret-change-in-production',
  'change-me-in-production',
  'change-me-too',
  'dev-settings-encryption-key-change-me',
]);

function getDefaultDevEncryptionKey() {
  return 'dev-settings-encryption-key-change-me';
}

const IS_PROD = process.env.NODE_ENV === 'production';

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
    clientUrl: process.env.CLIENT_URL || 'http://localhost:5174',
  },
  hyperliquid: {
    apiUrl: process.env.HL_API_URL || 'https://api.hyperliquid.xyz',
    wsUrl: process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws',
  },
  uniswap: {
    rpcUrls: {
      ethereum: process.env.UNI_RPC_ETHEREUM || 'https://ethereum-rpc.publicnode.com',
      arbitrum: process.env.UNI_RPC_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com',
      optimism: process.env.UNI_RPC_OPTIMISM || 'https://optimism-rpc.publicnode.com',
      base: process.env.UNI_RPC_BASE || 'https://base-rpc.publicnode.com',
      polygon: process.env.UNI_RPC_POLYGON || 'https://polygon-bor-rpc.publicnode.com',
    },
    scanTimeoutMs: parseInt(process.env.UNI_SCAN_TIMEOUT_MS, 10) || 20_000,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'changeme-use-a-strong-secret-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  security: {
    settingsEncryptionKey:
      process.env.SETTINGS_ENCRYPTION_KEY ||
      (IS_PROD ? '' : getDefaultDevEncryptionKey()),
  },
  trading: {
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE, 10) || 10,
    marginMode: process.env.MARGIN_MODE || 'cross',
    marketOrderSlippage: parseFloat(process.env.MARKET_ORDER_SLIPPAGE) || 0.002,
  },
  bots: {
    retryBaseMs: parseInt(process.env.BOT_RETRY_BASE_MS, 10) || 15_000,
    retryMaxMs: parseInt(process.env.BOT_RETRY_MAX_MS, 10) || 300_000,
    maxConsecutiveFailures: parseInt(process.env.BOT_MAX_CONSECUTIVE_FAILURES, 10) || 5,
    maxDegradedMs: parseInt(process.env.BOT_MAX_DEGRADED_MS, 10) || 900_000,
    maxStaleCandleMs: parseInt(process.env.BOT_MAX_STALE_CANDLE_MS, 10) || 120_000,
    maxStaleBalanceMs: parseInt(process.env.BOT_MAX_STALE_BALANCE_MS, 10) || 120_000,
  },
  intervals: {
    hedgeMonitorMs: parseInt(process.env.HEDGE_MONITOR_INTERVAL_MS, 10) || 10_000,
    hedgeClosingTimeoutMs: parseInt(process.env.HEDGE_CLOSING_TIMEOUT_MS, 10) || 90_000,
    hedgeCancelTimeoutMs: parseInt(process.env.HEDGE_CANCEL_TIMEOUT_MS, 10) || 300_000,
    protectedPoolRefreshMs: parseInt(process.env.PROTECTED_POOL_REFRESH_INTERVAL_MS, 10) || 600_000,
    telegramPollMs: parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS, 10) || 3_000,
    telegramConfigRefreshMs: parseInt(process.env.TELEGRAM_CONFIG_REFRESH_INTERVAL_MS, 10) || 60_000,
    telegramLongPollTimeoutSec: parseInt(process.env.TELEGRAM_LONG_POLL_TIMEOUT_SEC, 10) || 20,
    botEvalMs: parseInt(process.env.BOT_EVAL_INTERVAL_MS, 10) || 15_000,
    balanceCacheTtlMs: parseInt(process.env.BALANCE_CACHE_TTL_MS, 10) || 30_000,
    balanceRefreshMs: parseInt(process.env.BALANCE_REFRESH_INTERVAL_MS, 10) || 30_000,
    wsReconnectDelayMs: parseInt(process.env.WS_RECONNECT_DELAY_MS, 10) || 5_000,
    wsPingIntervalMs: parseInt(process.env.WS_PING_INTERVAL_MS, 10) || 30_000,
    wsWatchdogIntervalMs: parseInt(process.env.WS_WATCHDOG_INTERVAL_MS, 10) || 60_000,
    wsWatchdogMaxSilenceMs: parseInt(process.env.WS_WATCHDOG_MAX_SILENCE_MS, 10) || 90_000,
  },
};

// ------------------------------------------------------------------
// Validación de seguridad al arranque
// ------------------------------------------------------------------
function validateConfig() {
  const errors = [];

  if (IS_PROD) {
    if (!process.env.JWT_SECRET || INSECURE_VALUES.has(process.env.JWT_SECRET)) {
      errors.push('JWT_SECRET debe ser un valor seguro y único en producción');
    }
    if (!process.env.SETTINGS_ENCRYPTION_KEY || INSECURE_VALUES.has(process.env.SETTINGS_ENCRYPTION_KEY)) {
      errors.push('SETTINGS_ENCRYPTION_KEY debe ser un valor seguro y único en producción');
    }
    if (!process.env.DATABASE_URL) {
      errors.push('DATABASE_URL es requerido en producción');
    }
    if (config.server.clientUrl === '*') {
      errors.push('CLIENT_URL=* no está permitido en producción (configura un origen concreto)');
    }
  } else {
    if (!process.env.JWT_SECRET) {
      console.warn('[Config] JWT_SECRET no definido — usando valor por defecto (inseguro en producción)');
    }
    if (!process.env.SETTINGS_ENCRYPTION_KEY) {
      console.warn('[Config] SETTINGS_ENCRYPTION_KEY no definido — usando valor de desarrollo');
    }
  }

  if (errors.length > 0) {
    const msg = `[Config] Errores de configuración en producción:\n  - ${errors.join('\n  - ')}`;
    throw new Error(msg);
  }
}

validateConfig();

module.exports = config;
