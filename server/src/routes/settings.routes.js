/**
 * settings.routes.js
 *
 * API de configuración persistente del bot.
 * Guarda los settings en server/data/settings.json.
 *
 * GET  /api/settings              -> lee configuración actual (token enmascarado)
 * PUT  /api/settings/telegram     -> guarda token/chatId y reconfigura Telegram en caliente
 * POST /api/settings/telegram/test-> envía mensaje de prueba al chat configurado
 */

const { Router } = require('express');
const fs   = require('fs').promises;
const path = require('path');
const telegram = require('../services/telegram.service');

const router = Router();
const SETTINGS_FILE = path.join(__dirname, '../../data/settings.json');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { telegram: { token: '', chatId: '' } };
  }
}

async function writeSettings(data) {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function maskToken(token) {
  if (!token || token.length < 8) return token ? '***' : '';
  return token.slice(0, 6) + '***';
}

// ------------------------------------------------------------------
// Rutas
// ------------------------------------------------------------------

/** GET /api/settings */
router.get('/', async (req, res) => {
  try {
    const settings = await readSettings();
    const tg = settings.telegram || {};
    res.json({
      success: true,
      data: {
        telegram: {
          token:   maskToken(tg.token),
          chatId:  tg.chatId || '',
          enabled: !!(tg.token && tg.chatId),
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/settings/telegram */
router.put('/telegram', async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'token y chatId son requeridos' });
    }

    const settings = await readSettings();
    settings.telegram = { token: token.trim(), chatId: String(chatId).trim() };
    await writeSettings(settings);

    // Aplicar en caliente sin reiniciar
    telegram.configure(settings.telegram.token, settings.telegram.chatId);

    res.json({ success: true, data: { enabled: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/settings/telegram/test */
router.post('/telegram/test', async (req, res) => {
  try {
    if (!telegram.enabled) {
      return res.status(400).json({ success: false, error: 'Telegram no está configurado' });
    }
    await telegram.send('🔔 <b>Mensaje de prueba</b>\nHyperliquid Bot está configurado correctamente.');
    res.json({ success: true, data: { sent: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.loadSettings = async () => {
  const settings = await readSettings();
  const tg = settings.telegram;
  if (tg?.token && tg?.chatId) {
    telegram.configure(tg.token, tg.chatId);
  }
};
