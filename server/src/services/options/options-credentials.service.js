/**
 * options-credentials.service.js
 *
 * Credenciales de Binance Opciones (una cuenta por usuario) y límites globales
 * del módulo de opciones.
 *
 * - Las credenciales viven en `settings` con la clave `binance_options`, que
 *   está en SENSITIVE_KEYS y por tanto se guarda cifrada (AES-GCM).
 * - Nunca se devuelve el secret ni la API key completa: solo `apiKeyMasked`.
 * - Los límites viven en la clave `options_limits` (sin cifrar).
 */

const settingsService = require('../settings.service');
const { AppError, ValidationError } = require('../../errors/app-error');
const { createBinanceOptionsClient } = require('./binance-options.client');

const API_KEY_REGEX = /^[A-Za-z0-9]{16,128}$/;
const MAX_ALIAS_LENGTH = 60;
const DEFAULT_ALIAS = 'Binance Opciones';

const DEFAULT_LIMITS = Object.freeze({
  maxMarginUsdt: 5000,
  maxDailyLossUsdt: 500,
  maxLiveStrategies: 3,
  notifyTelegram: true,
});

// Permite inyectar la factoría del cliente en los tests.
let clientFactory = createBinanceOptionsClient;

function maskApiKey(apiKey) {
  const key = String(apiKey || '');
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function isConfigured(stored) {
  return Boolean(stored?.apiKey && stored?.apiSecret);
}

async function get(userId) {
  const stored = await settingsService.getBinanceOptions(userId);
  return {
    configured: isConfigured(stored),
    alias: stored?.alias || '',
    apiKeyMasked: maskApiKey(stored?.apiKey),
  };
}

/**
 * Guarda las credenciales. Un secret vacío conserva el anterior, siempre que
 * la API key no cambie (una key nueva necesita su propio secret). Una API key
 * vacía con credenciales ya guardadas conserva la key anterior (p. ej. al
 * cambiar solo el alias).
 */
async function set(userId, { alias, apiKey, apiSecret } = {}) {
  const previous = await settingsService.getBinanceOptions(userId);
  const nextAlias = String(alias ?? previous?.alias ?? '').trim() || DEFAULT_ALIAS;
  if (nextAlias.length > MAX_ALIAS_LENGTH) {
    throw new ValidationError(`alias no puede superar ${MAX_ALIAS_LENGTH} caracteres`);
  }

  const trimmedKey = String(apiKey ?? '').trim();
  const trimmedSecret = String(apiSecret ?? '').trim();

  const nextKey = trimmedKey || previous?.apiKey || '';
  if (!nextKey) throw new ValidationError('apiKey es requerida');
  if (!API_KEY_REGEX.test(nextKey)) {
    throw new ValidationError('apiKey con formato inválido (solo letras y números, 16-128 caracteres)');
  }

  const keyChanged = nextKey !== previous?.apiKey;
  let nextSecret = trimmedSecret;
  if (!nextSecret) {
    if (keyChanged || !previous?.apiSecret) {
      throw new ValidationError('apiSecret es requerido');
    }
    nextSecret = previous.apiSecret;
  } else if (!API_KEY_REGEX.test(nextSecret)) {
    throw new ValidationError('apiSecret con formato inválido (solo letras y números, 16-128 caracteres)');
  }

  await settingsService.setBinanceOptions(userId, {
    alias: nextAlias,
    apiKey: nextKey,
    apiSecret: nextSecret,
    updatedAt: Date.now(),
  });
  return get(userId);
}

async function remove(userId) {
  await settingsService.removeBinanceOptions(userId);
  return { configured: false, alias: '', apiKeyMasked: '' };
}

async function getClientForUser(userId, options = {}) {
  const stored = await settingsService.getBinanceOptions(userId);
  if (!isConfigured(stored)) {
    throw new AppError('Binance Opciones no está configurado. Añade tu API key en Configuración.', {
      status: 400,
      code: 'BINANCE_OPTIONS_NOT_CONFIGURED',
    });
  }
  return clientFactory({ ...options, apiKey: stored.apiKey, apiSecret: stored.apiSecret });
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

// -2018 (BALANCE_NOT_SUFFICIENT): en `marginAccount` significa que la cuenta
// de Opciones no está abierta o su cartera está vacía, no un fallo de la key.
const BALANCE_NOT_SUFFICIENT = -2018;

function describeAccountRejection(err) {
  const insufficient = err.details?.binanceCode === BALANCE_NOT_SUFFICIENT
    || /balance is insufficient/i.test(err.message || '');
  if (insufficient) {
    return 'La cuenta de Opciones no está activada o no tiene saldo. Actívala en Binance (Derivados → Opciones) '
      + 'y transfiere USDT a la cartera de Opciones de esta cuenta.';
  }
  return err.message;
}

/**
 * Verifica las credenciales contra Binance. Nunca lanza por un fallo de
 * Binance: cada comprobación devuelve ok | warn | fail con su detalle.
 */
async function test(userId) {
  const client = await getClientForUser(userId);
  const checks = [];

  let account = null;
  let accountError = null;
  try {
    account = await client.getAccount();
  } catch (err) {
    accountError = err;
  }

  if (!accountError) {
    checks.push(check('signature', 'Firma de la API', 'ok', 'Binance aceptó la firma HMAC.'));
    const usdt = Array.isArray(account?.asset)
      ? account.asset.find((a) => a.asset === 'USDT') || account.asset[0]
      : null;
    const equity = usdt ? Number(usdt.equity ?? usdt.marginBalance) : null;
    checks.push(check(
      'options_account',
      'Cuenta de opciones',
      'ok',
      Number.isFinite(equity) ? `Cuenta activa. Patrimonio: ${equity.toFixed(2)} USDT.` : 'Cuenta de opciones activa.'
    ));
  } else if (accountError.code === 'BINANCE_OPTIONS_AUTH_ERROR') {
    checks.push(check('signature', 'Firma de la API', 'fail', accountError.message));
    checks.push(check('options_account', 'Cuenta de opciones', 'fail', 'No se pudo consultar la cuenta: credenciales rechazadas.'));
  } else if (accountError.code === 'BINANCE_OPTIONS_REJECTED') {
    // Binance valida la firma antes que la lógica de negocio: si rechaza la
    // petición por otro motivo, la firma ya es correcta.
    checks.push(check('signature', 'Firma de la API', 'ok', 'Binance aceptó la firma HMAC.'));
    checks.push(check('options_account', 'Cuenta de opciones', 'fail', describeAccountRejection(accountError)));
  } else {
    checks.push(check('signature', 'Firma de la API', 'warn', 'No se pudo confirmar la firma: Binance respondió con otro error.'));
    checks.push(check('options_account', 'Cuenta de opciones', 'fail', accountError.message));
  }

  let restrictions = null;
  let restrictionsError = null;
  try {
    restrictions = await client.getApiRestrictions();
  } catch (err) {
    restrictionsError = err;
  }
  const unavailable = restrictionsError
    ? `No se pudieron leer las restricciones de la key en Binance (${restrictionsError.message}). Revísalas en la web de Binance.`
    : null;

  if (unavailable) {
    checks.push(check('trading_permission', 'Permiso de trading de opciones', 'warn', unavailable));
    checks.push(check('ip_restriction', 'Restricción por IP', 'warn', unavailable));
    checks.push(check('withdrawals_disabled', 'Retiros desactivados', 'warn', unavailable));
    return { checks };
  }

  if (restrictions?.enableVanillaOptions === true) {
    checks.push(check('trading_permission', 'Permiso de trading de opciones', 'ok', 'La key puede operar opciones europeas.'));
  } else if (restrictions?.enableVanillaOptions === false) {
    checks.push(check('trading_permission', 'Permiso de trading de opciones', 'fail', 'Activa «Enable European Options» en la API key.'));
  } else {
    checks.push(check('trading_permission', 'Permiso de trading de opciones', 'warn', 'Binance no informó el permiso de opciones de esta key.'));
  }

  if (restrictions?.ipRestrict === true) {
    checks.push(check('ip_restriction', 'Restricción por IP', 'ok', 'La key solo acepta IPs de confianza.'));
  } else {
    checks.push(check('ip_restriction', 'Restricción por IP', 'warn', 'La key no está restringida por IP. Se recomienda limitarla a la IP del servidor.'));
  }

  if (restrictions?.enableWithdrawals === false) {
    checks.push(check('withdrawals_disabled', 'Retiros desactivados', 'ok', 'La key no puede retirar fondos.'));
  } else if (restrictions?.enableWithdrawals === true) {
    checks.push(check('withdrawals_disabled', 'Retiros desactivados', 'warn', 'La key tiene los retiros habilitados. Desactívalos: la app no los necesita.'));
  } else {
    checks.push(check('withdrawals_disabled', 'Retiros desactivados', 'warn', 'Binance no informó si la key puede retirar fondos.'));
  }

  return { checks };
}

// ── Límites globales ───────────────────────────────────────────────

function parseLimitNumber(value, field, { integer = false, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new ValidationError(`${field} debe ser un número ${integer ? 'entero ' : ''}mayor o igual a cero${Number.isFinite(max) ? ` y como máximo ${max}` : ''}`);
  }
  return parsed;
}

function normalizeStoredLimits(stored) {
  const out = { ...DEFAULT_LIMITS };
  if (!stored || typeof stored !== 'object') return out;
  for (const field of ['maxMarginUsdt', 'maxDailyLossUsdt', 'maxLiveStrategies']) {
    const n = Number(stored[field]);
    if (Number.isFinite(n) && n >= 0) out[field] = n;
  }
  if (typeof stored.notifyTelegram === 'boolean') out.notifyTelegram = stored.notifyTelegram;
  return out;
}

async function getLimits(userId) {
  return normalizeStoredLimits(await settingsService.getOptionsLimits(userId));
}

/**
 * Actualiza los límites. Admite un parche parcial: los campos ausentes
 * conservan su valor actual.
 */
async function setLimits(userId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Límites inválidos');
  }
  const next = await getLimits(userId);
  if (patch.maxMarginUsdt !== undefined) next.maxMarginUsdt = parseLimitNumber(patch.maxMarginUsdt, 'maxMarginUsdt', { max: 1e9 });
  if (patch.maxDailyLossUsdt !== undefined) next.maxDailyLossUsdt = parseLimitNumber(patch.maxDailyLossUsdt, 'maxDailyLossUsdt', { max: 1e9 });
  if (patch.maxLiveStrategies !== undefined) next.maxLiveStrategies = parseLimitNumber(patch.maxLiveStrategies, 'maxLiveStrategies', { integer: true, max: 50 });
  if (patch.notifyTelegram !== undefined) {
    if (typeof patch.notifyTelegram !== 'boolean') throw new ValidationError('notifyTelegram debe ser booleano');
    next.notifyTelegram = patch.notifyTelegram;
  }
  await settingsService.setOptionsLimits(userId, next);
  return next;
}

function __setClientFactoryForTests(factory) {
  clientFactory = factory || createBinanceOptionsClient;
}

module.exports = {
  get,
  set,
  remove,
  test,
  getClientForUser,
  getLimits,
  setLimits,
  maskApiKey,
  DEFAULT_LIMITS,
  __setClientFactoryForTests,
};
