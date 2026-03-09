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
  wallet: {
    privateKey: process.env.PRIVATE_KEY,
    address: process.env.WALLET_ADDRESS,
  },
  trading: {
    defaultAsset: process.env.DEFAULT_ASSET || 'BTC',
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE, 10) || 10,
    marginMode: process.env.MARGIN_MODE || 'cross',
  },
};

function validateConfig() {
  const required = ['PRIVATE_KEY', 'WALLET_ADDRESS'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn(
      `[Config] Advertencia: variables de entorno faltantes: ${missing.join(', ')}`
    );
    console.warn('[Config] Las operaciones de trading no estaran disponibles.');
  }
}

validateConfig();

module.exports = config;
