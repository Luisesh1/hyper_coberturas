require('dotenv').config();

function getDefaultDevEncryptionKey() {
  return 'dev-settings-encryption-key-change-me';
}

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
      (process.env.NODE_ENV === 'production' ? '' : getDefaultDevEncryptionKey()),
  },
  trading: {
    defaultAsset: process.env.DEFAULT_ASSET || 'BTC',
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE, 10) || 10,
    marginMode: process.env.MARGIN_MODE || 'cross',
  },
};

if (!process.env.JWT_SECRET) {
  console.warn('[Config] JWT_SECRET no definido — usando valor por defecto (inseguro en producción)');
}
if (!process.env.SETTINGS_ENCRYPTION_KEY && process.env.NODE_ENV !== 'production') {
  console.warn('[Config] SETTINGS_ENCRYPTION_KEY no definido — usando valor de desarrollo');
}

module.exports = config;
