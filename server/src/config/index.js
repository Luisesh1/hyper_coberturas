require('dotenv').config();

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
  jwt: {
    secret: process.env.JWT_SECRET || 'changeme-use-a-strong-secret-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
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

module.exports = config;
