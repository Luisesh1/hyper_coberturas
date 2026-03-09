/**
 * settings.routes.js
 *
 * Configuración persistente — almacenada en PostgreSQL (tabla settings).
 * Mantiene compatibilidad con settings.json como fallback en primera carga.
 *
 * GET  /api/settings              -> lee configuración actual
 * PUT  /api/settings/telegram     -> guarda token/chatId
 * POST /api/settings/telegram/test-> envía mensaje de prueba
 */

const { Router } = require('express');
const fs       = require('fs').promises;
const path     = require('path');
const db       = require('../db');
const telegram = require('../services/telegram.service');

const router = Router();

// ------------------------------------------------------------------
// Helpers DB
// ------------------------------------------------------------------

async function getSetting(key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? JSON.parse(rows[0].value) : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
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
    const tg = (await getSetting('telegram')) || { token: '', chatId: '' };
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

router.put('/telegram', async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'token y chatId son requeridos' });
    }
    const tg = { token: token.trim(), chatId: String(chatId).trim() };
    await setSetting('telegram', tg);
    telegram.configure(tg.token, tg.chatId);
    res.json({ success: true, data: { enabled: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// Llamado desde index.js al arrancar para restaurar config de Telegram
module.exports.loadSettings = async () => {
  try {
    // Intentar cargar desde DB primero
    let tg = await getSetting('telegram');

    // Fallback: settings.json (migracion automatica en primer arranque)
    if (!tg) {
      const file = path.join(__dirname, '../../data/settings.json');
      try {
        const raw = await fs.readFile(file, 'utf8');
        const data = JSON.parse(raw);
        if (data?.telegram?.token && data?.telegram?.chatId) {
          tg = data.telegram;
          await setSetting('telegram', tg);
          console.log('[Settings] Configuracion migrada de settings.json a DB');
        }
      } catch { /* no hay archivo, es normal */ }
    }

    if (tg?.token && tg?.chatId) {
      telegram.configure(tg.token, tg.chatId);
      console.log('[Settings] Telegram configurado desde DB');
    }
  } catch (err) {
    console.error('[Settings] Error al cargar configuracion:', err.message);
  }
};
