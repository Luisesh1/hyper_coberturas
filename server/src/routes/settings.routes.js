/**
 * settings.routes.js
 *
 * Configuración persistente por usuario — almacenada en PostgreSQL.
 *
 * GET  /api/settings              → config actual del usuario autenticado
 * PUT  /api/settings/telegram     → guarda token/chatId del usuario
 * POST /api/settings/telegram/test→ envía mensaje de prueba
 * GET  /api/settings/wallet       → address del usuario (privateKey no se devuelve)
 * PUT  /api/settings/wallet       → guarda privateKey + address del usuario
 */

const { Router } = require('express');
const asyncHandler    = require('../middleware/async-handler');
const tgRegistry      = require('../services/telegram.registry');
const telegramCommandService = require('../services/telegram-command.service');
const hlRegistry      = require('../services/hyperliquid.registry');
const hedgeRegistry   = require('../services/hedge.registry');
const balanceCacheService = require('../services/balance-cache.service');
const hyperliquidAccountsService = require('../services/hyperliquid-accounts.service');
const settingsService = require('../services/settings.service');
const uniswapService  = require('../services/uniswap.service');
const logger = require('../services/logger.service');
const { authenticate } = require('../middleware/auth.middleware');
const { ValidationError } = require('../errors/app-error');

const router = Router();
router.use(authenticate);

function maskToken(token) {
  if (!token || token.length < 8) return token ? '***' : '';
  return token.slice(0, 6) + '***';
}

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------

router.get('/', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const tg     = await settingsService.getTelegram(userId);
  const wallet = await settingsService.getWallet(userId);
  const accounts = await hyperliquidAccountsService.listAccounts(userId);
  res.json({
    success: true,
    data: {
      telegram: {
        token:   maskToken(tg.token),
        chatId:  tg.chatId || '',
        enabled: !!(tg.token && tg.chatId),
      },
      wallet: {
        id: wallet.id || null,
        alias: wallet.alias || '',
        address:       wallet.address || '',
        hasPrivateKey: !!wallet.hasPrivateKey,
      },
      etherscan: {
        hasApiKey: !!(await settingsService.getEtherscan(userId)).apiKey,
      },
      alchemy: {
        hasApiKey: !!(await settingsService.getAlchemy(userId)).apiKey,
      },
      hyperliquidAccounts: {
        count: accounts.length,
        hasDefault: accounts.some((account) => account.isDefault),
      },
    },
  });
}));

router.put('/telegram', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { token, chatId } = req.body;
  if (!token || !chatId) {
    throw new ValidationError('token y chatId son requeridos');
  }
  const tg = { token: token.trim(), chatId: String(chatId).trim() };
  await settingsService.setTelegram(userId, tg);
  await tgRegistry.reload(userId);
  await telegramCommandService.refreshConfigs().catch((err) => logger.warn('telegram config refresh failed', { error: err.message }));
  res.json({ success: true, data: { enabled: true } });
}));

router.post('/telegram/test', asyncHandler(async (req, res) => {
  const tg = tgRegistry.get(req.user.userId);
  if (!tg?.enabled) {
    throw new ValidationError('Telegram no está configurado');
  }
  await tg.send('🔔 <b>Mensaje de prueba</b>\nHyperliquid Bot configurado correctamente.');
  res.json({ success: true, data: { sent: true } });
}));

router.get('/wallet', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const wallet = await settingsService.getWallet(userId);
  res.json({
    success: true,
    data: {
      id: wallet.id || null,
      alias: wallet.alias || '',
      address: wallet.address || '',
      hasPrivateKey: !!wallet.hasPrivateKey,
      isDefault: true,
    },
  });
}));

router.put('/wallet', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { privateKey, address, alias } = req.body;
  if (!privateKey || !address) {
    throw new ValidationError('privateKey y address son requeridos');
  }
  const account = await settingsService.setWallet(userId, {
    privateKey: privateKey.trim(),
    address: address.trim(),
    alias: alias?.trim() || 'Cuenta principal',
  });
  await hlRegistry.reload(userId, account.id);
  if (hedgeRegistry.get(userId, account.id)) {
    await hedgeRegistry.reload(userId, account.id);
  }
  balanceCacheService.invalidateAccount(userId, account.id);
  res.json({
    success: true,
    data: { id: account.id, alias: account.alias, address: account.address },
  });
}));

router.get('/hyperliquid-accounts', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const refreshAccountId = req.query.refreshAccountId ? Number(req.query.refreshAccountId) : null;
  const accounts = await hyperliquidAccountsService.listAccounts(userId);
  const enriched = await balanceCacheService.enrichAccounts(userId, accounts, { forceAccountId: refreshAccountId });
  res.json({ success: true, data: enriched });
}));

router.get('/hyperliquid-accounts/:id/summary', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const accountId = Number(req.params.id);
  const account = await hyperliquidAccountsService.getAccount(userId, accountId);
  const [balance] = await Promise.all([
    balanceCacheService.getBalance(userId, accountId, { force: req.query.refresh === '1' }),
  ]);
  res.json({
    success: true,
    data: {
      ...account,
      balanceUsd: balance.balanceUsd,
      lastBalanceUpdatedAt: balance.lastUpdatedAt,
    },
  });
}));

router.post('/hyperliquid-accounts', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { alias, address, privateKey, isDefault } = req.body;
  const account = await hyperliquidAccountsService.createAccount(userId, {
    alias,
    address,
    privateKey,
    isDefault,
  });
  balanceCacheService.invalidateUser(userId);
  await hlRegistry.reload(userId, account.id).catch((err) => logger.warn('hlRegistry reload failed', { userId, accountId: account.id, error: err.message }));
  res.status(201).json({ success: true, data: account });
}));

router.put('/hyperliquid-accounts/:id', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const accountId = Number(req.params.id);
  const { alias, address, privateKey, isDefault } = req.body;
  const account = await hyperliquidAccountsService.updateAccount(userId, accountId, {
    alias,
    address,
    privateKey,
    isDefault,
  });
  balanceCacheService.invalidateAccount(userId, accountId);
  await hlRegistry.reload(userId, accountId);
  if (hedgeRegistry.get(userId, accountId)) {
    await hedgeRegistry.reload(userId, accountId);
  }
  res.json({ success: true, data: account });
}));

router.put('/hyperliquid-accounts/:id/default', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const accountId = Number(req.params.id);
  const account = await hyperliquidAccountsService.setDefaultAccount(userId, accountId);
  balanceCacheService.invalidateUser(userId);
  res.json({ success: true, data: account });
}));

router.delete('/hyperliquid-accounts/:id', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const accountId = Number(req.params.id);
  const account = await hyperliquidAccountsService.deleteAccount(userId, accountId);
  balanceCacheService.invalidateAccount(userId, accountId);
  hlRegistry.destroy(userId, accountId);
  hedgeRegistry.destroy(userId, accountId);
  res.json({ success: true, data: account });
}));

router.get('/etherscan', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const etherscan = await settingsService.getEtherscan(userId);
  res.json({
    success: true,
    data: { hasApiKey: !!etherscan.apiKey },
  });
}));

router.put('/etherscan', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { apiKey } = req.body;
  if (!apiKey) {
    throw new ValidationError('apiKey es requerida');
  }
  await settingsService.setEtherscan(userId, {
    apiKey: String(apiKey).trim(),
  });
  res.json({ success: true, data: { hasApiKey: true } });
}));

router.post('/etherscan/test', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const result = await uniswapService.testUserEtherscanKey(userId);
  res.json({ success: true, data: result });
}));

// ------------------------------------------------------------------
// Alchemy
// ------------------------------------------------------------------

router.get('/alchemy', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const alchemy = await settingsService.getAlchemy(userId);
  res.json({
    success: true,
    data: { hasApiKey: !!alchemy.apiKey },
  });
}));

router.put('/alchemy', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { apiKey } = req.body;
  if (!apiKey) {
    throw new ValidationError('apiKey es requerida');
  }
  await settingsService.setAlchemy(userId, {
    apiKey: String(apiKey).trim(),
  });
  res.json({ success: true, data: { hasApiKey: true } });
}));

router.post('/alchemy/test', asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const result = await uniswapService.testUserAlchemyKey(userId);
  res.json({ success: true, data: result });
}));

module.exports = router;
