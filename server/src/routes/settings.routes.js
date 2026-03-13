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
    res.json({
      success: true,
      data: {
        telegram: {
          token:   maskToken(tg.token),
          chatId:  tg.chatId || '',
          enabled: !!(tg.token && tg.chatId),
        },
        wallet: {
          address:       wallet.address || '',
          hasPrivateKey: !!wallet.privateKey,
        },
        etherscan: {
          hasApiKey: !!(await settingsService.getEtherscan(userId)).apiKey,
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
      data: { address: wallet.address || '', hasPrivateKey: !!wallet.privateKey },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/wallet', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { privateKey, address } = req.body;
    if (!privateKey || !address) {
      throw new ValidationError('privateKey y address son requeridos');
    }
    await settingsService.setWallet(userId, {
      privateKey: privateKey.trim(),
      address: address.trim(),
    });
    await hlRegistry.reload(userId);
    if (hedgeRegistry.get(userId)) {
      await hedgeRegistry.reload(userId);
    }
    res.json({ success: true, data: { address: address.trim() } });
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
