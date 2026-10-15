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
const alertSignal = require('./alert-signal');

const TEMPLATES = [shortStrangle, coveredCall, protectivePut, alertSignal];
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function getTemplate(templateId) {
  const template = BY_ID.get(templateId);
  if (!template) throw new NotFoundError(`Template de estrategia desconocido: ${templateId}`);
  return template;
}

/** ¿Lo dispara una señal externa (bots por alertas) en vez del reloj? */
function isSignalDriven(templateId) {
  return Boolean(BY_ID.get(templateId)?.signalDriven);
}

/** Plantillas de la pestaña Estrategias (sin los bots por alertas). */
function listTemplates() {
  return TEMPLATES.filter((t) => !t.signalDriven).map((t) => ({
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
  isSignalDriven,
  validateParams: (templateId, params) => {
    const template = getTemplate(templateId);
    return template.validateParams ? template.validateParams(params) : validateParams(template, params);
  },
  pickExpiry,
};
