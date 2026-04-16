const httpClient = require('../shared/platform/http/http-client');

const config = require('../config');
const logger = require('./logger.service');
const settingsService = require('./settings.service');
const telegramRegistry = require('./telegram.registry');
const TelegramService = require('./telegram.service');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const hyperliquidRegistry = require('./hyperliquid.registry');
const TradingService = require('./trading.service');
const hedgeRepository = require('../repositories/hedge.repository');
const botsRepository = require('../repositories/bots.repository');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const {
  computeBackoffMs,
  extractTelegramRetryAfterMs,
  isTelegramRetryableError,
  sleep,
} = require('./external-service-helpers');

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CONFIG_REFRESH_MS = 60_000;
const DEFAULT_LONG_POLL_TIMEOUT_SEC = 20;
const MAX_LINES = 8;
const ALERTS_PAGE_SIZE = 10;

// Acciones que requieren selección de cuenta (cuenta-scoped)
const ACCOUNT_ACTIONS = {
  bal: 'saldo',
  pos: 'posiciones',
  ord: 'ordenes',
};

// Todas las acciones válidas (para decodeCallback)
const ALL_ACTIONS = {
  ...ACCOUNT_ACTIONS,
  res: 'resumen',
  stat: 'estado',
  hdg: 'coberturas',
  prot: 'protecciones',
  alrt: 'alertas',
  prc: 'precio',
  mnu: 'menu',
};

const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Menú principal y ayuda' },
  { command: 'menu', description: 'Abrir menú completo' },
  { command: 'resumen', description: 'Balance, posiciones y bots en un vistazo' },
  { command: 'saldo', description: 'Consultar saldo de la cuenta' },
  { command: 'posiciones', description: 'Ver posiciones abiertas' },
  { command: 'ordenes', description: 'Ver órdenes abiertas' },
  { command: 'status', description: 'Estado runtime de los bots' },
  { command: 'hedges', description: 'Coberturas activas' },
  { command: 'protecciones', description: 'Protecciones delta-neutral activas' },
  { command: 'alertas', description: 'Últimos eventos (24h)' },
  { command: 'precio', description: 'Precio perp de Hyperliquid (/precio BTC)' },
  { command: 'silenciar', description: 'Silenciar alertas (/silenciar 1h)' },
  { command: 'despertar', description: 'Quitar silencio activo' },
  { command: 'horario_silencio', description: 'Horario silencioso diario' },
  { command: 'alertas_config', description: 'Configurar categorías de alertas' },
];

// Textos de reply-keyboard persistente → comando interno
const REPLY_BUTTONS = new Map([
  ['📈 Resumen', '/resumen'],
  ['🔔 Alertas', '/alertas'],
  ['☰ Menú', '/menu'],
]);

function parseDurationToMs(input) {
  const str = String(input || '').trim().toLowerCase();
  const match = str.match(/^(\d+)\s*(m|min|minutos|h|hr|hora|horas|s|seg|segundos)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] || 'm';
  if (unit.startsWith('s')) return value * 1_000;
  if (unit.startsWith('h')) return value * 3_600_000;
  return value * 60_000;
}

function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

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
    // Acepta el alias legacy `deps.axios` (usado por tests existentes) o el
    // nombre nuevo `deps.http`. Default: helper interno basado en fetch.
    this.axios = deps.axios || deps.http || httpClient;
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
      nextAllowedAt: 0,
    };
  }

  async _telegramPost(poller, method, payload, timeoutMs) {
    const minIntervalMs = config.services?.telegram?.sendMinIntervalMs || 400;
    const maxAttempts = Math.max(1, Number(config.services?.telegram?.retryMaxAttempts) || 4);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const waitMs = Math.max(0, Number(poller?.nextAllowedAt || 0) - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      try {
        const response = await this.axios.post(
          `https://api.telegram.org/bot${poller.token}/${method}`,
          payload,
          { timeout: timeoutMs }
        );
        poller.nextAllowedAt = Date.now() + minIntervalMs;
        return response;
      } catch (err) {
        const retryAfterMs = extractTelegramRetryAfterMs(err);
        const retryable = isTelegramRetryableError(err);
        const lastAttempt = attempt >= maxAttempts - 1;
        if (!retryable || lastAttempt) {
          throw err;
        }

        const delayMs = retryAfterMs || computeBackoffMs(attempt, {
          baseMs: minIntervalMs,
          capMs: 8_000,
          jitterMs: 250,
        });
        poller.nextAllowedAt = Date.now() + delayMs;
        this.logger.warn('telegram_command_retry_scheduled', {
          method,
          attempt: attempt + 1,
          delayMs,
          retryAfterMs: retryAfterMs || null,
          tokenSuffix: poller.token.slice(-6),
          error: err.message,
        });
        await sleep(delayMs);
      }
    }

    return null;
  }

  async _syncCommands(poller) {
    const activeChatIds = new Set(
      [...poller.configsByChatId.keys()].map((chatId) => String(chatId))
    );

    for (const chatId of activeChatIds) {
      if (poller.commandScopesSynced.has(chatId)) continue;

      try {
        await this._telegramPost(
          poller,
          'setMyCommands',
          {
            commands: TELEGRAM_COMMANDS,
            scope: {
              type: 'chat',
              chat_id: chatId,
            },
          },
          5000
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
    let nextDelayMs = 0;

    try {
      const { data } = await this._telegramPost(
        poller,
        'getUpdates',
        {
          offset: poller.offset,
          timeout: this.longPollTimeoutSec,
          allowed_updates: ['message', 'callback_query'],
        },
        (this.longPollTimeoutSec + 5) * 1000
      );

      const updates = Array.isArray(data?.result) ? data.result : [];
      for (const update of updates) {
        poller.offset = Math.max(poller.offset, Number(update.update_id || 0) + 1);
        await this._processUpdate(poller, update);
      }
    } catch (err) {
      nextDelayMs = extractTelegramRetryAfterMs(err) || this.pollIntervalMs;
      this.logger.warn('telegram_command_get_updates_failed', {
        error: err.message,
        retryDelayMs: nextDelayMs,
        tokenSuffix: poller.token.slice(-6),
      });
    } finally {
      this._schedulePoll(poller, nextDelayMs);
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

  _encodeCallback(actionKey, accountId = 0, force = 0, page = 0, arg = '') {
    const parts = [`tg`, actionKey, String(Number(accountId) || 0), force ? '1' : '0'];
    if (page || arg) parts.push(String(page || 0));
    if (arg) parts.push(String(arg));
    return parts.join(':');
  }

  _decodeCallback(data) {
    const parts = String(data || '').split(':');
    const [prefix, actionKey, accountIdRaw, forceRaw, pageRaw, argRaw] = parts;
    if (prefix !== 'tg' || !ALL_ACTIONS[actionKey]) return null;
    return {
      actionKey,
      action: ALL_ACTIONS[actionKey],
      accountId: Number(accountIdRaw || 0),
      force: forceRaw === '1',
      page: Number(pageRaw || 0),
      arg: argRaw || '',
    };
  }

  _decodeCustomCallback(data) {
    // Para callbacks no-scoped (tg:cfg:..., tg:sil:..., tg:qh:..., tg:pg:...)
    const parts = String(data || '').split(':');
    if (parts[0] !== 'tg') return null;
    return { kind: parts[1] || '', args: parts.slice(2) };
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

  _buildReplyKeyboard() {
    return {
      keyboard: [
        [{ text: '📈 Resumen' }, { text: '🔔 Alertas' }],
        [{ text: '☰ Menú' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  async _sendHelp(userId, chatId) {
    const tg = await this._getTelegram(userId);
    const lines = [
      '🤖 <b>Bot Hyperliquid</b>',
      'Usa el menú persistente o los comandos:',
      '',
      '<b>Consultas</b>',
      '/resumen · /saldo · /posiciones · /ordenes',
      '/hedges · /protecciones · /status',
      '/alertas · /precio &lt;SYMBOL&gt;',
      '',
      '<b>Notificaciones</b>',
      '/silenciar &lt;15m|1h|8h&gt; · /despertar',
      '/horario_silencio &lt;HH:MM-HH:MM&gt; · /alertas_config',
    ].join('\n');

    await tg.sendToChat(chatId, lines, { replyMarkup: this._buildReplyKeyboard() });
    await this._sendMenu(userId, chatId);
  }

  _buildMenuKeyboard() {
    return buildInlineKeyboard([
      [
        { text: '💰 Saldo', callback_data: this._encodeCallback('bal', 0, 0) },
        { text: '📊 Posiciones', callback_data: this._encodeCallback('pos', 0, 0) },
      ],
      [
        { text: '🧾 Órdenes', callback_data: this._encodeCallback('ord', 0, 0) },
        { text: '📈 Resumen', callback_data: this._encodeCallback('res', 0, 0) },
      ],
      [
        { text: '🛡️ Coberturas', callback_data: this._encodeCallback('hdg', 0, 0) },
        { text: '⚖️ Protecciones', callback_data: this._encodeCallback('prot', 0, 0) },
      ],
      [
        { text: '🤖 Bots', callback_data: this._encodeCallback('stat', 0, 0) },
        { text: '🔔 Alertas', callback_data: this._encodeCallback('alrt', 0, 0, 0) },
      ],
      [
        { text: '⚙️ Notificaciones', callback_data: 'tg:cfg:open' },
      ],
    ]);
  }

  async _sendMenu(userId, chatId) {
    const tg = await this._getTelegram(userId);
    return tg.sendToChat(chatId, '📋 <b>Menú principal</b>\nElige una opción:', {
      replyMarkup: this._buildMenuKeyboard(),
    });
  }

  async _handleMessage(poller, message) {
    const chatId = message?.chat?.id;
    const cfg = this._resolveAuthorizedConfig(poller, chatId);
    if (!cfg) return;

    const rawText = String(message.text || '').trim();

    // Reply-keyboard literal texts → remap to slash command
    if (REPLY_BUTTONS.has(rawText)) {
      return this._routeCommand(cfg.userId, chatId, REPLY_BUTTONS.get(rawText), '');
    }

    const firstToken = rawText.split(/\s+/)[0] || '';
    const command = normalizeCommand(firstToken);
    if (!command.startsWith('/')) return;
    const argsText = rawText.slice(firstToken.length).trim();

    return this._routeCommand(cfg.userId, chatId, command, argsText);
  }

  async _routeCommand(userId, chatId, command, argsText = '') {
    switch (command) {
      case '/start':
        return this._sendHelp(userId, chatId);
      case '/menu':
        return this._sendMenu(userId, chatId);
      case '/saldo':
        return this._handleActionRequest(userId, chatId, { actionKey: 'bal', accountId: 0, force: false });
      case '/posiciones':
        return this._handleActionRequest(userId, chatId, { actionKey: 'pos', accountId: 0, force: false });
      case '/ordenes':
        return this._handleActionRequest(userId, chatId, { actionKey: 'ord', accountId: 0, force: false });
      case '/resumen':
        return this._sendResumen(userId, chatId);
      case '/status':
      case '/estado':
        return this._sendStatus(userId, chatId);
      case '/hedges':
      case '/coberturas':
        return this._sendHedges(userId, chatId);
      case '/protecciones':
        return this._sendProtecciones(userId, chatId);
      case '/alertas':
        return this._sendAlertas(userId, chatId, 0);
      case '/precio':
        return this._sendPrecio(userId, chatId, argsText);
      case '/silenciar':
        return this._handleSilenciar(userId, chatId, argsText);
      case '/despertar':
        return this._handleDespertar(userId, chatId);
      case '/horario_silencio':
        return this._handleHorarioSilencio(userId, chatId, argsText);
      case '/alertas_config':
        return this._sendAlertasConfig(userId, chatId);
      default: {
        const tg = await this._getTelegram(userId);
        return tg.sendToChat(chatId, 'Comando no reconocido. Usa /start para ver las opciones.');
      }
    }
  }

  async _handleCallback(poller, callbackQuery) {
    const chatId = callbackQuery?.message?.chat?.id;
    const cfg = this._resolveAuthorizedConfig(poller, chatId);
    if (!cfg) return;

    const tg = await this._getTelegram(cfg.userId);
    const data = String(callbackQuery.data || '');

    // Callbacks no-scoped
    const custom = this._decodeCustomCallback(data);
    if (custom && ['cfg', 'sil', 'qh', 'pg'].includes(custom.kind)) {
      await Promise.resolve(tg.answerCallbackQuery(callbackQuery.id)).catch(() => null);
      try {
        await this._handleCustomCallback(cfg.userId, chatId, custom);
      } catch (err) {
        this.logger.warn('telegram_custom_callback_failed', { kind: custom.kind, error: err.message });
      }
      return;
    }

    const parsed = this._decodeCallback(data);
    if (!parsed) {
      await tg.answerCallbackQuery(callbackQuery.id, { text: 'Acción no disponible' });
      return;
    }

    await Promise.resolve(tg.answerCallbackQuery(callbackQuery.id)).catch((err) => this.logger.warn('answerCallbackQuery failed', { error: err.message }));

    // Non-account-scoped actions via inline menu
    if (!ACCOUNT_ACTIONS[parsed.actionKey]) {
      switch (parsed.actionKey) {
        case 'res': return this._sendResumen(cfg.userId, chatId);
        case 'stat': return this._sendStatus(cfg.userId, chatId);
        case 'hdg': return this._sendHedges(cfg.userId, chatId);
        case 'prot': return this._sendProtecciones(cfg.userId, chatId);
        case 'alrt': return this._sendAlertas(cfg.userId, chatId, parsed.page || 0);
        case 'mnu': return this._sendMenu(cfg.userId, chatId);
        case 'prc': return this._sendPrecio(cfg.userId, chatId, parsed.arg || '');
        default: return null;
      }
    }

    await this._handleActionRequest(cfg.userId, chatId, parsed);
  }

  async _handleCustomCallback(userId, chatId, { kind, args }) {
    if (kind === 'cfg') {
      const [subKind, ...rest] = args;
      if (subKind === 'open') return this._sendAlertasConfig(userId, chatId);
      if (subKind === 'cat') {
        const [category, enabledRaw] = rest;
        const enabled = enabledRaw === '1';
        const prefs = await this.settingsService.getTelegramNotificationPrefs(userId);
        const categories = { ...prefs.categories, [category]: enabled };
        await this.settingsService.setTelegramNotificationPrefs(userId, { categories });
        await this.telegramRegistry.refreshPrefs?.(userId);
        return this._sendAlertasConfig(userId, chatId);
      }
    }
    if (kind === 'sil') {
      const [durationRaw] = args;
      if (durationRaw === 'off') return this._handleDespertar(userId, chatId);
      const ms = parseDurationToMs(durationRaw);
      return this._applySilence(userId, chatId, ms);
    }
    if (kind === 'qh') {
      const [subKind] = args;
      if (subKind === 'off') return this._handleHorarioSilencio(userId, chatId, 'off');
      return null;
    }
    if (kind === 'pg') {
      const [action, pageRaw] = args;
      const page = Number(pageRaw) || 0;
      if (action === 'alrt') return this._sendAlertas(userId, chatId, page);
      if (action === 'hdg') return this._sendHedges(userId, chatId, page);
      if (action === 'prot') return this._sendProtecciones(userId, chatId, page);
      return null;
    }
    return null;
  }

  async _handleActionRequest(userId, chatId, { actionKey, accountId, force }) {
    const tg = await this._getTelegram(userId);
    const action = ACCOUNT_ACTIONS[actionKey];
    if (!action) {
      await tg.sendToChat(chatId, 'Acción no disponible.');
      return;
    }
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
    } else {
      // Intentar usar la última cuenta usada si sigue existiendo
      try {
        const prefs = await this.settingsService.getTelegramNotificationPrefs(userId);
        const lastId = Number(prefs?.lastAccountId);
        if (lastId > 0) {
          selectedAccount = accounts.find((a) => Number(a.id) === lastId) || null;
        }
      } catch {
        // ignore
      }
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
      } else if (actionKey === 'pos') {
        await this._sendPositions(userId, chatId, selectedAccount, force);
      } else if (actionKey === 'ord') {
        await this._sendOrders(userId, chatId, selectedAccount, force);
      }
      await this._persistLastAccountId(userId, selectedAccount.id);
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

  async _persistLastAccountId(userId, accountId) {
    try {
      await this.settingsService.setTelegramNotificationPrefs(userId, { lastAccountId: accountId });
      await this.telegramRegistry.refreshPrefs?.(userId);
    } catch (err) {
      this.logger.debug?.('telegram_persist_last_account_failed', { error: err.message });
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

  // ------------------------------------------------------------------
  // Comandos nuevos (A) — lectura / observabilidad
  // ------------------------------------------------------------------

  async _sendResumen(userId, chatId) {
    const tg = await this._getTelegram(userId);
    const accounts = await this.accountsService.listAccounts(userId).catch(() => []);

    if (!accounts.length) {
      await tg.sendToChat(chatId, 'No hay cuentas configuradas.');
      return;
    }

    const accountSummaries = await Promise.all(accounts.map(async (account) => {
      try {
        const trading = await this.tradingFactory(userId, account.id);
        const state = await trading.getAccountState({ force: false });
        const unrealized = Array.isArray(state.positions)
          ? state.positions.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0)
          : 0;
        return {
          alias: account.alias || account.shortAddress || `Cuenta #${account.id}`,
          accountValue: state.accountValue,
          withdrawable: state.withdrawable,
          positions: Array.isArray(state.positions) ? state.positions.length : 0,
          unrealized,
        };
      } catch (err) {
        return { alias: account.alias, error: err.message };
      }
    }));

    const [bots, hedges, protections] = await Promise.all([
      botsRepository.listByUser(userId).catch(() => []),
      hedgeRepository.loadAllByUser(userId).catch(() => []),
      protectedPoolRepository.listByUser(userId).catch(() => []),
    ]);

    const activeBots = bots.filter((b) => b.status === 'active').length;
    const pausedBots = bots.filter((b) => b.status === 'paused').length;
    const activeHedges = hedges.filter((h) => !['closed', 'cancelled'].includes(h.status)).length;
    const activeProtections = protections.filter((p) => p.status === 'active').length;

    const lines = ['📈 <b>Resumen</b>', ''];
    for (const s of accountSummaries) {
      lines.push(`<b>${escapeHtml(s.alias)}</b>`);
      if (s.error) {
        lines.push(`  ⚠️ ${escapeHtml(s.error)}`);
      } else {
        lines.push(
          `  Balance: ${formatUsd(s.accountValue)} · Retirable: ${formatUsd(s.withdrawable)}`,
          `  Posiciones: ${s.positions} · uPnL: ${formatUsd(s.unrealized)}`,
        );
      }
      lines.push('');
    }
    lines.push(
      '<b>Sistema</b>',
      `  🤖 Bots activos: ${activeBots}${pausedBots ? ` · ⏸️ pausados: ${pausedBots}` : ''}`,
      `  🛡️ Coberturas activas: ${activeHedges}`,
      `  ⚖️ Protecciones activas: ${activeProtections}`,
    );

    await tg.sendToChat(chatId, lines.join('\n'));
  }

  async _sendStatus(userId, chatId) {
    const tg = await this._getTelegram(userId);
    const bots = await botsRepository.listByUser(userId).catch(() => []);

    if (!bots.length) {
      await tg.sendToChat(chatId, '🤖 Sin bots configurados.');
      return;
    }

    const statusEmoji = {
      active: '✅',
      paused: '⏸️',
      stopped: '⛔',
      failed: '❌',
    };

    const lines = ['🤖 <b>Estado de bots</b>', ''];
    bots.slice(0, 12).forEach((bot) => {
      const emoji = statusEmoji[bot.status] || 'ℹ️';
      lines.push(`${emoji} <b>#${bot.id}</b> · ${escapeHtml(bot.asset || 'N/A')} · ${escapeHtml(bot.status || '?')}`);
      if (bot.last_error) {
        lines.push(`   ⚠️ ${escapeHtml(String(bot.last_error).slice(0, 120))}`);
      }
      if (bot.updated_at) {
        lines.push(`   Actualizado: ${escapeHtml(formatTimestamp(bot.updated_at))}`);
      }
    });
    if (bots.length > 12) lines.push('', `... y ${bots.length - 12} más`);

    await tg.sendToChat(chatId, lines.join('\n'));
  }

  async _sendHedges(userId, chatId, page = 0) {
    const tg = await this._getTelegram(userId);
    const all = await hedgeRepository.loadAllByUser(userId).catch(() => []);
    const active = all
      .filter((h) => !['closed', 'cancelled'].includes(h.status))
      .sort((a, b) => (b.id || 0) - (a.id || 0));

    if (!active.length) {
      await tg.sendToChat(chatId, '🛡️ Sin coberturas activas.');
      return;
    }

    const totalPages = Math.max(1, Math.ceil(active.length / MAX_LINES));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = active.slice(safePage * MAX_LINES, (safePage + 1) * MAX_LINES);

    const lines = [`🛡️ <b>Coberturas activas</b> (${active.length})`];
    slice.forEach((h, idx) => {
      const n = safePage * MAX_LINES + idx + 1;
      const side = String(h.direction || 'short').toUpperCase();
      lines.push(
        '',
        `${n}. <b>#${h.id}</b> · ${escapeHtml(h.asset || 'N/A')} · ${side} · ${escapeHtml(h.status || '?')}`,
        `Entry: $${escapeHtml(formatPrice(h.entryPrice))} · SL: $${escapeHtml(formatPrice(h.exitPrice))}`,
        `Tam: ${escapeHtml(formatSize(h.size))} · ${h.leverage || 1}x`,
      );
      if (h.unrealizedPnlUsd != null) {
        lines.push(`uPnL: ${escapeHtml(formatUsd(h.unrealizedPnlUsd))}`);
      }
    });

    const keyboard = this._buildPaginationKeyboard('hdg', safePage, totalPages);
    await tg.sendToChat(chatId, lines.join('\n'), keyboard ? { replyMarkup: keyboard } : {});
  }

  async _sendProtecciones(userId, chatId, page = 0) {
    const tg = await this._getTelegram(userId);
    const all = await protectedPoolRepository.listByUser(userId).catch(() => []);
    const active = all.filter((p) => p.status === 'active');

    if (!active.length) {
      await tg.sendToChat(chatId, '⚖️ Sin protecciones delta-neutral activas.');
      return;
    }

    const totalPages = Math.max(1, Math.ceil(active.length / MAX_LINES));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = active.slice(safePage * MAX_LINES, (safePage + 1) * MAX_LINES);

    const lines = [`⚖️ <b>Protecciones activas</b> (${active.length})`];
    slice.forEach((p, idx) => {
      const n = safePage * MAX_LINES + idx + 1;
      const pair = `${p.token0Symbol || '?'}/${p.token1Symbol || '?'}`;
      lines.push(
        '',
        `${n}. <b>#${p.id}</b> · ${escapeHtml(pair)} · ${escapeHtml(p.inferredAsset || 'N/A')}`,
        `Notional: ${escapeHtml(formatUsd(p.hedgeNotionalUsd))}`,
        `Rango: $${escapeHtml(formatPrice(p.rangeLowerPrice))} → $${escapeHtml(formatPrice(p.rangeUpperPrice))}`,
      );
      if (p.priceCurrent != null) {
        lines.push(`Precio actual: $${escapeHtml(formatPrice(p.priceCurrent))}`);
      }
    });

    const keyboard = this._buildPaginationKeyboard('prot', safePage, totalPages);
    await tg.sendToChat(chatId, lines.join('\n'), keyboard ? { replyMarkup: keyboard } : {});
  }

  async _sendAlertas(userId, chatId, page = 0) {
    const tg = await this._getTelegram(userId);
    const alerts = TelegramService.listRecentAlerts(userId, { limit: 50 });

    if (!alerts.length) {
      await tg.sendToChat(chatId, '🔔 Sin alertas recientes (últimas 24h).');
      return;
    }

    const totalPages = Math.max(1, Math.ceil(alerts.length / ALERTS_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = alerts.slice(safePage * ALERTS_PAGE_SIZE, (safePage + 1) * ALERTS_PAGE_SIZE);

    const severityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '🔔',
    };

    const lines = [`🔔 <b>Alertas recientes</b> (${alerts.length} en 24h)`];
    slice.forEach((a, idx) => {
      const n = safePage * ALERTS_PAGE_SIZE + idx + 1;
      const emoji = severityEmoji[a.severity] || '•';
      const when = new Date(a.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      lines.push(`${n}. ${emoji} <code>${when}</code> · ${escapeHtml(a.title || a.category)}`);
    });

    const keyboard = this._buildPaginationKeyboard('alrt', safePage, totalPages);
    await tg.sendToChat(chatId, lines.join('\n'), keyboard ? { replyMarkup: keyboard } : {});
  }

  async _sendPrecio(userId, chatId, argsText) {
    const tg = await this._getTelegram(userId);
    const symbol = String(argsText || '').trim().toUpperCase();

    if (!symbol) {
      await tg.sendToChat(chatId, 'Uso: <code>/precio BTC</code>');
      return;
    }

    try {
      const apiUrl = (config.hyperliquid && config.hyperliquid.apiUrl) || 'https://api.hyperliquid.xyz';
      const { data } = await this.axios.post(`${apiUrl}/info`, { type: 'allMids' }, { timeout: 5000 });
      const mids = data || {};
      const price = mids[symbol];
      if (!price) {
        await tg.sendToChat(chatId, `Símbolo <b>${escapeHtml(symbol)}</b> no encontrado.`);
        return;
      }
      await tg.sendToChat(
        chatId,
        [
          `💹 <b>${escapeHtml(symbol)} perp</b>`,
          `Mark: $${escapeHtml(formatPrice(Number(price)))}`,
          `Fuente: Hyperliquid · ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`,
        ].join('\n'),
      );
    } catch (err) {
      this.logger.warn('telegram_precio_failed', { symbol, error: err.message });
      await tg.sendToChat(chatId, `No se pudo consultar el precio: ${escapeHtml(err.message)}`);
    }
  }

  // ------------------------------------------------------------------
  // Comandos nuevos (C) — gestión de notificaciones
  // ------------------------------------------------------------------

  async _handleSilenciar(userId, chatId, argsText) {
    const ms = parseDurationToMs(argsText);
    if (!ms) {
      const tg = await this._getTelegram(userId);
      await tg.sendToChat(chatId, [
        '🔕 <b>Silenciar alertas</b>',
        'Uso: <code>/silenciar &lt;15m|1h|8h&gt;</code>',
        '',
        'Ejemplos: <code>/silenciar 30m</code>, <code>/silenciar 2h</code>',
      ].join('\n'), {
        replyMarkup: buildInlineKeyboard([
          [
            { text: '15m', callback_data: 'tg:sil:15m' },
            { text: '1h', callback_data: 'tg:sil:1h' },
            { text: '8h', callback_data: 'tg:sil:8h' },
          ],
        ]),
      });
      return;
    }
    await this._applySilence(userId, chatId, ms);
  }

  async _applySilence(userId, chatId, ms) {
    const until = Date.now() + ms;
    await this.settingsService.setTelegramNotificationPrefs(userId, { silencedUntil: until });
    await this.telegramRegistry.refreshPrefs?.(userId);
    const tg = await this._getTelegram(userId);
    const whenStr = new Date(until).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
    await tg.sendToChat(chatId, `🔕 Silencio activo durante ${formatDurationShort(ms)} (hasta ${whenStr}).`);
  }

  async _handleDespertar(userId, chatId) {
    await this.settingsService.setTelegramNotificationPrefs(userId, { silencedUntil: null });
    await this.telegramRegistry.refreshPrefs?.(userId);
    const tg = await this._getTelegram(userId);
    await tg.sendToChat(chatId, '🔔 Silencio desactivado. Recibirás alertas nuevamente.');
  }

  async _handleHorarioSilencio(userId, chatId, argsText) {
    const tg = await this._getTelegram(userId);
    const raw = String(argsText || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'quitar' || raw === 'desactivar') {
      await this.settingsService.setTelegramNotificationPrefs(userId, { quietHours: null });
      await this.telegramRegistry.refreshPrefs?.(userId);
      await tg.sendToChat(chatId, '⏰ Horario silencioso desactivado.');
      return;
    }
    const match = raw.match(/^(\d{1,2}):(\d{2})\s*[-–a]\s*(\d{1,2}):(\d{2})$/);
    if (!match) {
      const prefs = await this.settingsService.getTelegramNotificationPrefs(userId);
      const current = prefs.quietHours
        ? `Actual: ${prefs.quietHours.start}-${prefs.quietHours.end} (${prefs.quietHours.tz})`
        : 'Actualmente desactivado.';
      await tg.sendToChat(chatId, [
        '⏰ <b>Horario silencioso diario</b>',
        current,
        '',
        'Uso: <code>/horario_silencio 22:00-07:00</code>',
        'Apagar: <code>/horario_silencio off</code>',
      ].join('\n'), {
        replyMarkup: buildInlineKeyboard([[{ text: 'Desactivar', callback_data: 'tg:qh:off' }]]),
      });
      return;
    }
    const hh1 = Math.min(23, Number(match[1]));
    const mm1 = Math.min(59, Number(match[2]));
    const hh2 = Math.min(23, Number(match[3]));
    const mm2 = Math.min(59, Number(match[4]));
    const start = `${String(hh1).padStart(2, '0')}:${String(mm1).padStart(2, '0')}`;
    const end = `${String(hh2).padStart(2, '0')}:${String(mm2).padStart(2, '0')}`;
    await this.settingsService.setTelegramNotificationPrefs(userId, {
      quietHours: { start, end, tz: 'America/Mexico_City' },
    });
    await this.telegramRegistry.refreshPrefs?.(userId);
    await tg.sendToChat(chatId, `⏰ Horario silencioso: ${start}-${end} (America/Mexico_City). No recibirás alertas no-críticas en ese rango.`);
  }

  async _sendAlertasConfig(userId, chatId) {
    const tg = await this._getTelegram(userId);
    const prefs = await this.settingsService.getTelegramNotificationPrefs(userId);
    const catLabels = {
      hedge: 'Coberturas',
      trade: 'Trades manuales',
      runtime: 'Runtime bots',
      deltaNeutralBlock: 'Bloqueos delta-neutral',
    };
    const silenceStatus = prefs.silencedUntil && prefs.silencedUntil > Date.now()
      ? `🔕 Silencio hasta ${new Date(prefs.silencedUntil).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}`
      : '🔔 Sin silencio temporal';
    const quietStatus = prefs.quietHours
      ? `⏰ Horario silencioso: ${prefs.quietHours.start}-${prefs.quietHours.end}`
      : '⏰ Sin horario silencioso';
    const digestStatus = prefs.digest?.enabled
      ? `📦 Digest: ≥${prefs.digest.minEvents} eventos/${Math.round(prefs.digest.windowMs / 1000)}s`
      : '📦 Digest: desactivado';

    const lines = [
      '⚙️ <b>Configuración de alertas</b>',
      silenceStatus,
      quietStatus,
      digestStatus,
      '',
      '<b>Categorías</b> (toca para alternar):',
    ];
    for (const [cat, label] of Object.entries(catLabels)) {
      const on = prefs.categories[cat] !== false;
      lines.push(`${on ? '✅' : '❌'} ${label}`);
    }

    const rows = [];
    for (const [cat, label] of Object.entries(catLabels)) {
      const on = prefs.categories[cat] !== false;
      rows.push([{
        text: `${on ? '✅' : '❌'} ${label}`,
        callback_data: `tg:cfg:cat:${cat}:${on ? '0' : '1'}`,
      }]);
    }
    rows.push([
      { text: '15m', callback_data: 'tg:sil:15m' },
      { text: '1h', callback_data: 'tg:sil:1h' },
      { text: '8h', callback_data: 'tg:sil:8h' },
      { text: '🔔 Quitar', callback_data: 'tg:sil:off' },
    ]);

    await tg.sendToChat(chatId, lines.join('\n'), {
      replyMarkup: buildInlineKeyboard(rows),
    });
  }

  _buildPaginationKeyboard(actionKey, page, totalPages) {
    if (totalPages <= 1) return null;
    const row = [];
    if (page > 0) row.push({ text: '◀ Prev', callback_data: `tg:pg:${actionKey}:${page - 1}` });
    row.push({ text: `${page + 1}/${totalPages}`, callback_data: `tg:pg:${actionKey}:${page}` });
    if (page < totalPages - 1) row.push({ text: 'Next ▶', callback_data: `tg:pg:${actionKey}:${page + 1}` });
    return buildInlineKeyboard([row]);
  }
}

module.exports = new TelegramCommandService();
module.exports.TelegramCommandService = TelegramCommandService;
