const indicatorsRepository = require('../repositories/strategy-indicators.repository');
const strategyEngine = require('./strategy-engine.service');
const marketDataService = require('./market-data.service');
const { ValidationError, NotFoundError } = require('../errors/app-error');

const DEFAULT_INDICATOR_SOURCE = `module.exports.compute = function compute(input, params = {}) {
  const period = Number(params.period || 5);
  if (!Array.isArray(input) || input.length < period) return [];
  const closes = input.map((item) => Number(item.close ?? item));
  return closes.map((value, index) => {
    if (index < period - 1) return null;
    const window = closes.slice(index - period + 1, index + 1);
    const sum = window.reduce((acc, current) => acc + current, 0);
    return Number((sum / period).toFixed(6));
  });
};`;

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSlug(slug) {
  const normalized = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new ValidationError('slug es requerido');
  return normalized;
}

function normalizeInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new ValidationError('name es requerido');
  const slug = normalizeSlug(input.slug || name);
  const scriptSource = String(input.scriptSource || '').trim() || DEFAULT_INDICATOR_SOURCE;
  if (!scriptSource) throw new ValidationError('scriptSource es requerido');
  const parameterSchema = parseJson(input.parameterSchema, {});
  if (parameterSchema && typeof parameterSchema !== 'object') {
    throw new ValidationError('parameterSchema debe ser un objeto JSON');
  }
  return {
    name,
    slug,
    scriptSource,
    parameterSchema,
  };
}

function mapIndicator(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    slug: row.slug,
    scriptSource: row.script_source,
    parameterSchema: parseJson(row.parameter_schema_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function validateIndicatorSource({ slug, scriptSource, parameterSchema }) {
  const candles = await marketDataService.getCandles('BTC', '15m', { limit: 50 });
  await strategyEngine.validateIndicator({
    slug,
    source: scriptSource,
    input: candles,
    params: parameterSchema?.defaults || { period: 5 },
  });
}

async function listIndicators(userId) {
  const rows = await indicatorsRepository.listByUser(userId);
  return rows.map(mapIndicator);
}

async function createIndicator(userId, input) {
  const indicator = normalizeInput(input);
  const existing = await indicatorsRepository.getBySlug(userId, indicator.slug);
  if (existing) throw new ValidationError('Ya existe un indicador con ese slug');
  await validateIndicatorSource(indicator);
  const row = await indicatorsRepository.create(userId, {
    ...indicator,
    parameterSchemaJson: JSON.stringify(indicator.parameterSchema),
    now: Date.now(),
  });
  return mapIndicator(row);
}

async function updateIndicator(userId, indicatorId, input) {
  const current = await indicatorsRepository.getById(userId, indicatorId);
  if (!current) throw new NotFoundError('Indicador no encontrado');

  const indicator = normalizeInput({
    ...mapIndicator(current),
    ...input,
  });

  const duplicate = await indicatorsRepository.getBySlug(userId, indicator.slug);
  if (duplicate && Number(duplicate.id) !== Number(indicatorId)) {
    throw new ValidationError('Ya existe un indicador con ese slug');
  }

  await validateIndicatorSource(indicator);
  const row = await indicatorsRepository.update(userId, indicatorId, {
    ...indicator,
    parameterSchemaJson: JSON.stringify(indicator.parameterSchema),
    now: Date.now(),
  });
  return mapIndicator(row);
}

async function deleteIndicator(userId, indicatorId) {
  const removed = await indicatorsRepository.remove(userId, indicatorId);
  if (!removed) throw new NotFoundError('Indicador no encontrado');
  return { removed: true };
}

module.exports = {
  DEFAULT_INDICATOR_SOURCE,
  createIndicator,
  deleteIndicator,
  listIndicators,
  mapIndicator,
  updateIndicator,
};
