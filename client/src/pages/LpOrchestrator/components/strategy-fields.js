/**
 * Definición única de los campos de configuración de estrategia.
 *
 * El wizard de creación y el modal de edición pedían exactamente los mismos
 * campos, cada uno con su propia copia del label y de los min/max/step — y
 * solo el wizard traía los tooltips, así que la misma opción estaba explicada
 * en un lado y a ciegas en el otro. Con una sola definición, agregar o
 * retocar un campo se hace en un lugar y los dos formularios quedan iguales.
 *
 * Los rangos espejan `strategyConfigSchema` en
 * server/src/schemas/lp-orchestrator.schema.js: si divergen, el formulario
 * deja mandar algo que el backend rechaza.
 */

export const STRATEGY_FIELDS = [
  {
    key: 'rangeWidthPct',
    label: 'Ancho del rango (±%)',
    min: 0.1,
    max: 99,
    step: 0.5,
    tooltip: 'Define el ancho del LP en Uniswap. El LP se centra en el precio actual y se extiende ±este % a cada lado. Valores típicos: 1-3% (estrecho, más fees, mayor riesgo de salir de rango), 5-10% (medio), >10% (amplio, menos fees, más estable).',
  },
  {
    key: 'edgeMarginPct',
    label: 'Margen de borde (%)',
    min: 5,
    max: 49,
    step: 1,
    tooltip: "Cuánto del rango cuenta como 'borde' a cada lado. Si pones 40%, los bordes ocupan el 40% inferior + 40% superior = 80%, y el centro 'sin alerta' es solo el 20% central. Cuando el precio entra al borde, el orquestador evalúa si vale la pena rebalancear.",
  },
  {
    key: 'costToRewardThreshold',
    label: 'Umbral coste / recompensa',
    min: 0.01,
    max: 0.99,
    step: 0.01,
    tooltip: 'Solo se recomienda rebalancear cuando el coste estimado (gas + slippage) es menor que ganancias_netas × este valor. Default 0.33 → coste < 1/3 de las ganancias netas del LP. Subirlo recomienda más rebalanceos; bajarlo, menos.',
  },
  {
    key: 'reinvestThresholdUsd',
    label: 'Umbral reinvest fees (USD)',
    min: 0,
    step: 1,
    tooltip: 'El orquestador recomendará cobrar/reinvertir las fees del LP cuando las acumuladas superen este USD. Pon 0 para desactivar la recomendación.',
  },
  {
    key: 'urgentAlertRepeatMinutes',
    label: 'Repetir alerta urgente cada (min)',
    min: 1,
    max: 1440,
    step: 1,
    tooltip: 'Cuando el LP queda fuera de rango, el orquestador envía una alerta y la repite cada N minutos hasta que el precio vuelva al rango o la posición se ajuste.',
  },
  {
    key: 'minRebalanceCooldownSec',
    label: 'Cooldown anti-thrashing (s)',
    min: 0,
    step: 60,
    tooltip: 'Tiempo mínimo (en segundos) entre rebalanceos consecutivos para evitar que pequeñas oscilaciones del precio disparen muchos rebalanceos seguidos.',
  },
  {
    key: 'minNetLpEarningsForRebalanceUsd',
    label: 'Min ganancias netas LP para rebalancear (USD)',
    min: 0,
    step: 1,
    tooltip: 'Piso absoluto de ganancias netas acumuladas del LP antes de recomendar un rebalanceo. Evita rebalancear posiciones que todavía no generaron lo suficiente como para pagar el coste.',
  },
  {
    key: 'maxSlippageBps',
    label: 'Max slippage swaps (bps)',
    min: 1,
    max: 1000,
    step: 1,
    tooltip: 'Tolerancia máxima de slippage para los swaps de rebalanceo, en puntos básicos (100 bps = 1%). Más bajo protege el precio pero hace que la transacción falle más seguido.',
  },
];

export const STRATEGY_FIELD_BY_KEY = Object.fromEntries(
  STRATEGY_FIELDS.map((field) => [field.key, field])
);

/**
 * Validación compartida. Devuelve un mensaje o null. Se usa antes de enviar
 * en ambos formularios para no depender solo del rechazo del backend.
 */
export function validateStrategyFields(values) {
  for (const field of STRATEGY_FIELDS) {
    const raw = values?.[field.key];
    // Un campo ausente usa el default del backend; uno vaciado a mano es un
    // olvido — dejarlo pasar mandaria 0 y el backend lo rechazaria sin decir
    // cual fue.
    if (raw === undefined || raw === null) continue;
    if (raw === '') return `${field.label}: falta completar.`;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
      return `${field.label}: debe ser un número.`;
    }
    if (field.min != null && numeric < field.min) {
      return `${field.label}: el mínimo es ${field.min}.`;
    }
    if (field.max != null && numeric > field.max) {
      return `${field.label}: el máximo es ${field.max}.`;
    }
  }
  return null;
}
