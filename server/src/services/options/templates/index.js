/**
 * Registro de templates de estrategias de opciones. Cada template es puro:
 * `evaluate(ctx)` → acciones `open | close | hold | skip`. Lo usan igual el
 * runner (sombra/real) y el backtest.
 */

const { NotFoundError } = require('../../../errors/app-error');
const { validateParams, pickExpiry } = require('./helpers');
const shortStrangle = require('./short-strangle');
const coveredCall = require('./covered-call');
const protectivePut = require('./protective-put');

const TEMPLATES = [shortStrangle, coveredCall, protectivePut];
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function getTemplate(templateId) {
  const template = BY_ID.get(templateId);
  if (!template) throw new NotFoundError(`Template de estrategia desconocido: ${templateId}`);
  return template;
}

function listTemplates() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    holdsSpot: t.holdsSpot,
    defaultParams: { ...t.defaultParams },
    paramSchema: t.paramSchema.map((f) => ({ ...f })),
  }));
}

module.exports = {
  TEMPLATE_IDS: TEMPLATES.map((t) => t.id),
  getTemplate,
  listTemplates,
  validateParams: (templateId, params) => validateParams(getTemplate(templateId), params),
  pickExpiry,
};
