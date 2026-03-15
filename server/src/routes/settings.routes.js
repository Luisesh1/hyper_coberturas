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
const tgRegistry      = require('../services/telegram.registry');
const hlRegistry      = require('../services/hyperliquid.registry');
const hedgeRegistry   = require('../services/hedge.registry');
const balanceCacheService = require('../services/balance-cache.service');
const hyperliquidAccountsService = require('../services/hyperliquid-accounts.service');
const settingsService = require('../services/settings.service');
const uniswapService  = require('../services/uniswap.service');
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

router.get('/', async (req, res, next) => {
  try {
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
        hyperliquidAccounts: {
          count: accounts.length,
          hasDefault: accounts.some((account) => account.isDefault),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/telegram', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { token, chatId } = req.body;
    if (!token || !chatId) {
      throw new ValidationError('token y chatId son requeridos');
    }
    const tg = { token: token.trim(), chatId: String(chatId).trim() };
    await settingsService.setTelegram(userId, tg);
    await tgRegistry.reload(userId);
    res.json({ success: true, data: { enabled: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/telegram/test', async (req, res, next) => {
  try {
    const tg = tgRegistry.get(req.user.userId);
    if (!tg?.enabled) {
      throw new ValidationError('Telegram no está configurado');
    }
    await tg.send('🔔 <b>Mensaje de prueba</b>\nHyperliquid Bot configurado correctamente.');
    res.json({ success: true, data: { sent: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/wallet', async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

router.put('/wallet', async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

router.get('/hyperliquid-accounts', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const refreshAccountId = req.query.refreshAccountId ? Number(req.query.refreshAccountId) : null;
    const accounts = await hyperliquidAccountsService.listAccounts(userId);
    const enriched = await balanceCacheService.enrichAccounts(userId, accounts, { forceAccountId: refreshAccountId });
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
});

router.get('/hyperliquid-accounts/:id/summary', async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

router.post('/hyperliquid-accounts', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { alias, address, privateKey, isDefault } = req.body;
    const account = await hyperliquidAccountsService.createAccount(userId, {
      alias,
      address,
      privateKey,
      isDefault,
    });
    balanceCacheService.invalidateUser(userId);
    await hlRegistry.reload(userId, account.id).catch(() => {});
    res.status(201).json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
});

router.put('/hyperliquid-accounts/:id', async (req, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

router.put('/hyperliquid-accounts/:id/default', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const accountId = Number(req.params.id);
    const account = await hyperliquidAccountsService.setDefaultAccount(userId, accountId);
    balanceCacheService.invalidateUser(userId);
    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
});

router.delete('/hyperliquid-accounts/:id', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const accountId = Number(req.params.id);
    const account = await hyperliquidAccountsService.deleteAccount(userId, accountId);
    balanceCacheService.invalidateAccount(userId, accountId);
    hlRegistry.destroy(userId, accountId);
    hedgeRegistry.destroy(userId, accountId);
    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
});

router.get('/etherscan', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const etherscan = await settingsService.getEtherscan(userId);
    res.json({
      success: true,
      data: { hasApiKey: !!etherscan.apiKey },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/etherscan', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { apiKey } = req.body;
    if (!apiKey) {
      throw new ValidationError('apiKey es requerida');
    }
    await settingsService.setEtherscan(userId, {
      apiKey: String(apiKey).trim(),
    });
    res.json({ success: true, data: { hasApiKey: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/etherscan/test', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const result = await uniswapService.testUserEtherscanKey(userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
