const axios = require('axios');

const config = require('../config');
const logger = require('./logger.service');
const settingsService = require('./settings.service');
const telegramRegistry = require('./telegram.registry');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const hyperliquidRegistry = require('./hyperliquid.registry');
const TradingService = require('./trading.service');

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CONFIG_REFRESH_MS = 60_000;
const DEFAULT_LONG_POLL_TIMEOUT_SEC = 20;
const MAX_LINES = 8;

const ACTIONS = {
  bal: 'saldo',
  pos: 'posiciones',
  ord: 'ordenes',
};

const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Ver ayuda y opciones disponibles' },
  { command: 'saldo', description: 'Consultar saldo de la cuenta' },
  { command: 'posiciones', description: 'Ver posiciones abiertas' },
  { command: 'ordenes', description: 'Ver ordenes abiertas' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUsd(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'N/A';
  return `$${parsed.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'N/A';
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSize(value, digits = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'N/A';
  return parsed.toFixed(digits);
}

function formatTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'N/A';
  return new Date(parsed).toLocaleString('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function buildInlineKeyboard(rows) {
  const filtered = rows.filter((row) => Array.isArray(row) && row.length > 0);
  return filtered.length ? { inline_keyboard: filtered } : null;
}

function normalizeCommand(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)[0]
    .split('@')[0]
    .toLowerCase();
}

class TelegramCommandService {
  constructor(deps = {}) {
    this.axios = deps.axios || axios;
    this.logger = deps.logger || logger;
    this.settingsService = deps.settingsService || settingsService;
    this.telegramRegistry = deps.telegramRegistry || telegramRegistry;
    this.accountsService = deps.hyperliquidAccountsService || hyperliquidAccountsService;
    this.hyperliquidRegistry = deps.hyperliquidRegistry || hyperliquidRegistry;
    this.tradingFactory = deps.tradingFactory || this._defaultTradingFactory.bind(this);
    this.pollIntervalMs = deps.pollIntervalMs || config.intervals.telegramPollMs || DEFAULT_POLL_INTERVAL_MS;
    this.configRefreshMs = deps.configRefreshMs || config.intervals.telegramConfigRefreshMs || DEFAULT_CONFIG_REFRESH_MS;
    this.longPollTimeoutSec = deps.longPollTimeoutSec || config.intervals.telegramLongPollTimeoutSec || DEFAULT_LONG_POLL_TIMEOUT_SEC;

    this.running = false;
    this.refreshTimer = null;
    this.pollers = new Map();
  }

  async _defaultTradingFactory(userId, accountId) {
    const [account, hl, tg] = await Promise.all([
      this.accountsService.resolveAccount(userId, accountId),
      this.hyperliquidRegistry.getOrCreate(userId, accountId),
      this.telegramRegistry.getOrCreate(userId),
    ]);
    return new TradingService(userId, account, hl, tg);
  }

  async _getTelegram(userId) {
    return this.telegramRegistry.get(userId) || this.telegramRegistry.getOrCreate(userId);
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.refreshConfigs().catch((err) => {
      this.logger.warn('telegram_command_refresh_failed', { error: err.message });
    });

    this.refreshTimer = setInterval(() => {
      this.refreshConfigs().catch((err) => {
        this.logger.warn('telegram_command_periodic_refresh_failed', { error: err.message });
      });
    }, this.configRefreshMs);
    this.refreshTimer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    for (const poller of this.pollers.values()) {
      this._stopPoller(poller);
    }
    this.pollers.clear();
  }

  async refreshConfigs() {
    const configs = await this.settingsService.listTelegramConfigs();
    const byToken = new Map();

    for (const configEntry of configs) {
      const token = String(configEntry.token || '').trim();
      const chatId = String(configEntry.chatId || '').trim();
      if (!token || !chatId) continue;

      const tokenGroup = byToken.get(token) || new Map();
      tokenGroup.set(chatId, configEntry);
      byToken.set(token, tokenGroup);
    }

    for (const [token, configsByChatId] of byToken.entries()) {
      const poller = this.pollers.get(token);
      if (poller) {
        poller.configsByChatId = configsByChatId;
        await this._syncCommands(poller);
        if (this.running && !poller.timer && !poller.stopped) {
          this._schedulePoll(poller, 0);
        }
        continue;
      }

      const nextPoller = this._createPoller(token, configsByChatId);
      this.pollers.set(token, nextPoller);
      await this._syncCommands(nextPoller);
      this._schedulePoll(nextPoller, 0);
    }

    for (const [token, poller] of this.pollers.entries()) {
      if (byToken.has(token)) continue;
      this._stopPoller(poller);
      this.pollers.delete(token);
    }

    return byToken.size;
  }

  _createPoller(token, configsByChatId) {
    return {
      token,
      offset: 0,
      configsByChatId,
      commandScopesSynced: new Set(),
      timer: null,
      stopped: false,
    };
  }

  async _syncCommands(poller) {
    const activeChatIds = new Set(
      [...poller.configsByChatId.keys()].map((chatId) => String(chatId))
    );

    for (const chatId of activeChatIds) {
      if (poller.commandScopesSynced.has(chatId)) continue;

      try {
        await this.axios.post(
          `https://api.telegram.org/bot${poller.token}/setMyCommands`,
          {
            commands: TELEGRAM_COMMANDS,
            scope: {
              type: 'chat',
              chat_id: chatId,
            },
          },
          {
            timeout: 5000,
          }
        );
        poller.commandScopesSynced.add(chatId);
      } catch (err) {
        this.logger.warn('telegram_command_set_my_commands_failed', {
          chatId,
          error: err.message,
          tokenSuffix: poller.token.slice(-6),
        });
      }
    }

    for (const chatId of [...poller.commandScopesSynced]) {
      if (!activeChatIds.has(chatId)) {
        poller.commandScopesSynced.delete(chatId);
      }
    }
  }

  _stopPoller(poller) {
    poller.stopped = true;
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = null;
    }
  }

  _schedulePoll(poller, delayMs = this.pollIntervalMs) {
    if (!this.running || poller.stopped) return;
    poller.timer = setTimeout(() => {
      this._pollOnce(poller).catch((err) => {
        this.logger.warn('telegram_command_poll_failed', {
          error: err.message,
          tokenSuffix: poller.token.slice(-6),
        });
      });
    }, delayMs);
    poller.timer.unref?.();
  }

  async _pollOnce(poller) {
    if (!this.running || poller.stopped) return;

    try {
      const { data } = await this.axios.post(
        `https://api.telegram.org/bot${poller.token}/getUpdates`,
        {
          offset: poller.offset,
          timeout: this.longPollTimeoutSec,
          allowed_updates: ['message', 'callback_query'],
        },
        {
          timeout: (this.longPollTimeoutSec + 5) * 1000,
        }
      );

      const updates = Array.isArray(data?.result) ? data.result : [];
      for (const update of updates) {
        poller.offset = Math.max(poller.offset, Number(update.update_id || 0) + 1);
        await this._processUpdate(poller, update);
      }
    } catch (err) {
      this.logger.warn('telegram_command_get_updates_failed', {
        error: err.message,
        tokenSuffix: poller.token.slice(-6),
      });
    } finally {
      this._schedulePoll(poller, 0);
    }
  }

  async _processUpdate(poller, update) {
    if (update?.message?.text) {
      await this._handleMessage(poller, update.message);
      return;
    }
    if (update?.callback_query) {
      await this._handleCallback(poller, update.callback_query);
    }
  }

  _resolveAuthorizedConfig(poller, chatId) {
    return poller.configsByChatId.get(String(chatId)) || null;
  }

  _encodeCallback(actionKey, accountId = 0, force = 0) {
    return `tg:${actionKey}:${Number(accountId) || 0}:${force ? 1 : 0}`;
  }

  _decodeCallback(data) {
    const [prefix, actionKey, accountIdRaw, forceRaw] = String(data || '').split(':');
    if (prefix !== 'tg' || !ACTIONS[actionKey]) return null;
    return {
      actionKey,
      action: ACTIONS[actionKey],
      accountId: Number(accountIdRaw || 0),
      force: forceRaw === '1',
    };
  }

  _buildRefreshKeyboard(actionKey, accountId) {
    return buildInlineKeyboard([[
      {
        text: 'Refrescar',
        callback_data: this._encodeCallback(actionKey, accountId, 1),
      },
    ]]);
  }

  _buildAccountPickerKeyboard(accounts, actionKey) {
    return buildInlineKeyboard(
      accounts.slice(0, 12).map((account) => ([{
        text: account.alias || account.shortAddress || `Cuenta #${account.id}`,
        callback_data: this._encodeCallback(actionKey, account.id, 0),
      }]))
    );
  }

  async _sendHelp(userId, chatId) {
    const tg = await this._getTelegram(userId);
    const accounts = await this.accountsService.listAccounts(userId).catch(() => []);
    const singleAccountId = accounts.length === 1 ? accounts[0].id : 0;

    const keyboard = buildInlineKeyboard([[
      { text: 'Saldo', callback_data: this._encodeCallback('bal', singleAccountId, 0) },
      { text: 'Posiciones', callback_data: this._encodeCallback('pos', singleAccountId, 0) },
      { text: 'Órdenes', callback_data: this._encodeCallback('ord', singleAccountId, 0) },
    ]]);

    return tg.sendToChat(chatId, [
      '🤖 <b>Bot de consultas Hyperliquid</b>',
      'Comandos disponibles:',
      '/saldo',
      '/posiciones',
      '/ordenes',
      '',
      'Responde desde caché y puedes refrescar manualmente desde los botones.',
    ].join('\n'), { replyMarkup: keyboard });
  }

  async _handleMessage(poller, message) {
    const chatId = message?.chat?.id;
    const cfg = this._resolveAuthorizedConfig(poller, chatId);
    if (!cfg) return;

    const command = normalizeCommand(message.text);
    if (!command.startsWith('/')) return;

    if (command === '/start') {
      await this._sendHelp(cfg.userId, chatId);
      return;
    }
    if (command === '/saldo') {
      await this._handleActionRequest(cfg.userId, chatId, { actionKey: 'bal', accountId: 0, force: false });
      return;
    }
    if (command === '/posiciones') {
      await this._handleActionRequest(cfg.userId, chatId, { actionKey: 'pos', accountId: 0, force: false });
      return;
    }
    if (command === '/ordenes') {
      await this._handleActionRequest(cfg.userId, chatId, { actionKey: 'ord', accountId: 0, force: false });
      return;
    }

    const tg = await this._getTelegram(cfg.userId);
    await tg.sendToChat(chatId, 'Comando no reconocido. Usa /start para ver las opciones.');
  }

  async _handleCallback(poller, callbackQuery) {
    const chatId = callbackQuery?.message?.chat?.id;
    const cfg = this._resolveAuthorizedConfig(poller, chatId);
    if (!cfg) return;

    const parsed = this._decodeCallback(callbackQuery.data);
    const tg = await this._getTelegram(cfg.userId);

    if (!parsed) {
      await tg.answerCallbackQuery(callbackQuery.id, {
        text: 'Acción no disponible',
      });
      return;
    }

    await Promise.resolve(tg.answerCallbackQuery(callbackQuery.id)).catch((err) => logger.warn('answerCallbackQuery failed', { error: err.message }));
    await this._handleActionRequest(cfg.userId, chatId, parsed);
  }

  async _handleActionRequest(userId, chatId, { actionKey, accountId, force }) {
    const tg = await this._getTelegram(userId);
    const action = ACTIONS[actionKey];
    const accounts = await this.accountsService.listAccounts(userId);

    if (!accounts.length) {
      await tg.sendToChat(chatId, 'No hay cuentas de Hyperliquid configuradas para este usuario.');
      return;
    }

    let selectedAccount = null;
    if (accountId > 0) {
      selectedAccount = accounts.find((account) => Number(account.id) === Number(accountId)) || null;
      if (!selectedAccount) {
        await tg.sendToChat(chatId, 'La cuenta seleccionada ya no existe o no está disponible.');
        return;
      }
    } else if (accounts.length === 1) {
      [selectedAccount] = accounts;
    }

    if (!selectedAccount) {
      await tg.sendToChat(
        chatId,
        `Selecciona una cuenta para consultar <b>${escapeHtml(action)}</b>.`,
        { replyMarkup: this._buildAccountPickerKeyboard(accounts, actionKey) }
      );
      return;
    }

    try {
      if (actionKey === 'bal') {
        await this._sendBalance(userId, chatId, selectedAccount, force);
        return;
      }
      if (actionKey === 'pos') {
        await this._sendPositions(userId, chatId, selectedAccount, force);
        return;
      }
      if (actionKey === 'ord') {
        await this._sendOrders(userId, chatId, selectedAccount, force);
      }
    } catch (err) {
      this.logger.warn('telegram_command_action_failed', {
        userId,
        action,
        accountId: selectedAccount.id,
        error: err.message,
      });
      await tg.sendToChat(chatId, `No se pudo consultar ${escapeHtml(action)}: ${escapeHtml(err.message)}`);
    }
  }

  async _sendBalance(userId, chatId, account, force) {
    const tg = await this._getTelegram(userId);
    const trading = await this.tradingFactory(userId, account.id);
    const data = await trading.getAccountState({ force });

    const lines = [
      `💰 <b>Saldo de ${escapeHtml(account.alias)}</b>`,
      `Balance: <b>${formatUsd(data.accountValue)}</b>`,
      `Retirable: <b>${formatUsd(data.withdrawable)}</b>`,
      `Margen usado: <b>${formatUsd(data.totalMarginUsed)}</b>`,
      `Notional abierto: <b>${formatUsd(data.totalNtlPos)}</b>`,
      `Posiciones abiertas: <b>${Array.isArray(data.positions) ? data.positions.length : 0}</b>`,
      `Actualizado: ${escapeHtml(formatTimestamp(data.lastUpdatedAt))}`,
      force ? 'Origen: exchange' : 'Origen: caché',
    ];

    await tg.sendToChat(chatId, lines.join('\n'), {
      replyMarkup: this._buildRefreshKeyboard('bal', account.id),
    });
  }

  async _sendPositions(userId, chatId, account, force) {
    const tg = await this._getTelegram(userId);
    const trading = await this.tradingFactory(userId, account.id);
    const data = await trading.getAccountState({ force });
    const positions = Array.isArray(data.positions) ? data.positions : [];

    const lines = [
      `📊 <b>Posiciones de ${escapeHtml(account.alias)}</b>`,
    ];

    if (!positions.length) {
      lines.push('Sin posiciones abiertas.');
    } else {
      positions.slice(0, MAX_LINES).forEach((position, index) => {
        lines.push(
          '',
          `${index + 1}. <b>${escapeHtml(position.asset)}</b> · ${escapeHtml(String(position.side || '').toUpperCase())}`,
          `Tam: ${escapeHtml(formatSize(position.size))}`,
          `Entry: $${escapeHtml(formatPrice(position.entryPrice))}`,
          `uPnL: ${escapeHtml(formatUsd(position.unrealizedPnl))}`,
          `Liq: $${escapeHtml(formatPrice(position.liquidationPrice))}`
        );
      });
      if (positions.length > MAX_LINES) {
        lines.push('', `... y ${positions.length - MAX_LINES} más`);
      }
    }

    lines.push('', `Actualizado: ${escapeHtml(formatTimestamp(data.lastUpdatedAt))}`, force ? 'Origen: exchange' : 'Origen: caché');

    await tg.sendToChat(chatId, lines.join('\n'), {
      replyMarkup: this._buildRefreshKeyboard('pos', account.id),
    });
  }

  async _sendOrders(userId, chatId, account, force) {
    const tg = await this._getTelegram(userId);
    const trading = await this.tradingFactory(userId, account.id);
    const data = await trading.getOpenOrders({ force });
    const orders = Array.isArray(data.orders) ? data.orders : [];

    const lines = [
      `🧾 <b>Órdenes abiertas de ${escapeHtml(account.alias)}</b>`,
    ];

    if (!orders.length) {
      lines.push('Sin órdenes abiertas.');
    } else {
      orders.slice(0, MAX_LINES).forEach((order, index) => {
        const side = order.side === 'B' ? 'BUY' : 'SELL';
        const price = order.limitPx || order.triggerPx || order.sz;
        lines.push(
          '',
          `${index + 1}. <b>${escapeHtml(order.coin || 'N/A')}</b> · ${side}`,
          `Tipo: ${escapeHtml(order.orderType || 'Limit')}`,
          `Tam: ${escapeHtml(formatSize(order.sz))}`,
          `Precio: $${escapeHtml(formatPrice(price))}`
        );
      });
      if (orders.length > MAX_LINES) {
        lines.push('', `... y ${orders.length - MAX_LINES} más`);
      }
    }

    lines.push('', `Actualizado: ${escapeHtml(formatTimestamp(data.lastUpdatedAt))}`, force ? 'Origen: exchange' : 'Origen: caché');

    await tg.sendToChat(chatId, lines.join('\n'), {
      replyMarkup: this._buildRefreshKeyboard('ord', account.id),
    });
  }
}

module.exports = new TelegramCommandService();
module.exports.TelegramCommandService = TelegramCommandService;
