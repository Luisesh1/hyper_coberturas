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
const db              = require('../db');
const tgRegistry      = require('../services/telegram.registry');
const hlRegistry      = require('../services/hyperliquid.registry');
const hedgeRegistry   = require('../services/hedge.registry');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

// ------------------------------------------------------------------
// Helpers DB (scoped por user_id)
// ------------------------------------------------------------------

async function getSetting(userId, key) {
  const { rows } = await db.query(
    'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
    [userId, key]
  );
  return rows.length ? JSON.parse(rows[0].value) : null;
}

async function setSetting(userId, key, value) {
  await db.query(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [userId, key, JSON.stringify(value), Date.now()]
  );
}

function maskToken(token) {
  if (!token || token.length < 8) return token ? '***' : '';
  return token.slice(0, 6) + '***';
}

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const tg     = (await getSetting(userId, 'telegram')) || { token: '', chatId: '' };
    const wallet = (await getSetting(userId, 'wallet'))   || { address: '' };
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
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/telegram', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { token, chatId } = req.body;
    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'token y chatId son requeridos' });
    }
    const tg = { token: token.trim(), chatId: String(chatId).trim() };
    await setSetting(userId, 'telegram', tg);
    await tgRegistry.reload(userId);
    res.json({ success: true, data: { enabled: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/telegram/test', async (req, res) => {
  try {
    const tg = tgRegistry.get(req.user.userId);
    if (!tg?.enabled) {
      return res.status(400).json({ success: false, error: 'Telegram no está configurado' });
    }
    await tg.send('🔔 <b>Mensaje de prueba</b>\nHyperliquid Bot configurado correctamente.');
    res.json({ success: true, data: { sent: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/wallet', async (req, res) => {
  try {
    const userId = req.user.userId;
    const wallet = (await getSetting(userId, 'wallet')) || {};
    res.json({
      success: true,
      data: { address: wallet.address || '', hasPrivateKey: !!wallet.privateKey },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/wallet', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { privateKey, address } = req.body;
    if (!privateKey || !address) {
      return res.status(400).json({ success: false, error: 'privateKey y address son requeridos' });
    }
    await setSetting(userId, 'wallet', { privateKey: privateKey.trim(), address: address.trim() });
    await hlRegistry.reload(userId);
    const existingHedge = hedgeRegistry.get(userId);
    if (existingHedge) existingHedge.stopMonitor();
    res.json({ success: true, data: { address: address.trim() } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
