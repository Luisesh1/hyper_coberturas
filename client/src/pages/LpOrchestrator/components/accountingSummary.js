/**
 * Resume la contabilidad de un orquestador en las tres cifras que la tarjeta
 * necesita para dar un veredicto: cuánto puso el LP, cuánto se llevó la
 * cobertura, y el neto con su porcentaje sobre el capital.
 *
 * Vive aparte de `AccountingPanel` porque ahora lo consumen dos sitios (el
 * veredicto de la tarjeta y el panel plegado) y no pueden discrepar: si el
 * encabezado dijera un número y el detalle otro, la tarjeta perdería
 * justamente la credibilidad que este rediseño busca.
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * La pata de cobertura se calcula sumando sus cinco componentes, con los
 * costes restando — la misma convención que `recomputeNetPnl` en el servidor.
 */
export function computeHedgeNetUsd(accounting) {
  const a = accounting || {};
  return num(a.hedgeRealizedPnlUsd)
    + num(a.hedgeUnrealizedPnlUsd)
    + num(a.hedgeFundingUsd)
    - num(a.hedgeExecutionFeesUsd)
    - num(a.hedgeSlippageUsd);
}

/**
 * @param {object|null} accounting  `orchestrator.accounting`
 * @param {number|null} initialTotalUsd  capital inicial, para el porcentaje
 */
export function computeAccountingSummary(accounting, initialTotalUsd = null) {
  const a = accounting || {};
  const hasTotal = Number.isFinite(Number(a.totalNetPnlUsd));
  const totalNetUsd = hasTotal ? Number(a.totalNetPnlUsd) : null;
  const hedgeNetUsd = computeHedgeNetUsd(a);

  // La pata LP se DERIVA del total menos la de cobertura, en vez de volver a
  // sumar fees + deriva - gas - slippage. Así las dos patas siempre reconcilian
  // con el neto que se muestra, aunque el servidor agregue un componente nuevo
  // (p. ej. `capitalAdjustmentsUsd`) que este cliente todavía no conozca.
  const lpNetUsd = hasTotal ? totalNetUsd - hedgeNetUsd : null;

  const initial = Number(initialTotalUsd);
  const netPct = Number.isFinite(initial) && initial > 0 && hasTotal
    ? (totalNetUsd / initial) * 100
    : null;

  return { lpNetUsd, hedgeNetUsd, totalNetUsd, netPct };
}

/**
 * La frase que hace la suma por el usuario. Es el corazón del rediseño: antes
 * la tarjeta mostraba doce componentes y dejaba la conclusión a cargo de quien
 * mirara. Devuelve `null` cuando no hay contabilidad — sin datos no hay nada
 * que afirmar, y una frase inventada sería peor que ninguna.
 */
export function buildVerdictSentence(summary) {
  if (!summary || summary.totalNetUsd == null) return null;
  const { lpNetUsd, hedgeNetUsd, totalNetUsd } = summary;

  const lpWins = lpNetUsd > 0;
  const hedgeLoses = hedgeNetUsd < 0;

  // El caso que motivó todo esto: el LP gana y la cobertura se lo come.
  if (lpWins && hedgeLoses && totalNetUsd < 0) {
    return 'El hedge se está comiendo las fees del LP.';
  }
  if (!lpWins && hedgeLoses) {
    return 'Las dos patas pierden: la cobertura no está compensando al LP.';
  }
  if (lpWins && !hedgeLoses) {
    return 'Las dos patas suman.';
  }
  if (!lpWins && !hedgeLoses) {
    return 'La cobertura está sosteniendo el resultado mientras el LP pierde.';
  }
  return totalNetUsd >= 0
    ? 'El LP compensa lo que cuesta la cobertura.'
    : 'La cobertura cuesta más de lo que rinde el LP.';
}
