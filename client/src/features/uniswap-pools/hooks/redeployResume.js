/**
 * Retomar un redespliegue (modify-range / rebalance) cortado a la mitad.
 *
 * El plan retira TODA la liquidez en su primera tx. Si una tx posterior falla
 * (swap, aprobación, mint), la posición ya quedó vacía y su capital está en la
 * wallet: volver a preparar el plan entero revienta con "La posicion no tiene
 * liquidez ni fees que redesplegar". En ese caso "Reintentar" tiene que pedir
 * un plan que arranque en el swap/mint con el capital que liberó el retiro.
 *
 * Devuelve `{ resumeFunding, priorTxHashes }` o null si no hay que retomar.
 * `priorTxHashes` son las txs ya minadas, que el finalize necesita para la
 * contabilidad completa del ajuste.
 */
const RESUMABLE_ACTIONS = new Set(['modify-range', 'rebalance']);

function validFunding(funding) {
  return funding?.amount0Raw != null && funding?.amount1Raw != null
    ? { amount0Raw: String(funding.amount0Raw), amount1Raw: String(funding.amount1Raw) }
    : null;
}

export function buildRedeployResume({ action, prepareData, completed, txHashes = [], previous = null }) {
  if (!RESUMABLE_ACTIONS.has(action)) return null;
  const plan = prepareData?.txPlan || [];
  const summary = prepareData?.quoteSummary || {};
  const alreadyResumed = summary.resumed === true;
  const done = Number.isInteger(completed) && completed > 0 ? Math.min(completed, plan.length) : 0;

  // Un plan retomado que falla antes de minar nada sigue igual que antes.
  if (done === 0) return alreadyResumed ? previous : null;
  if (done >= plan.length) return null;

  const doneKinds = plan.slice(0, done).map((tx) => tx?.kind);
  const withdrawn = alreadyResumed || doneKinds.some((kind) => String(kind || '').startsWith('decrease_liquidity'));
  if (!withdrawn) return null;

  const swapped = doneKinds.some((kind) => String(kind || '').startsWith('swap'));
  const resumeFunding = validFunding(swapped ? summary.postSwapFunding : summary.redeployFunding);
  if (!resumeFunding) return null;

  return {
    resumeFunding,
    priorTxHashes: [
      ...(alreadyResumed ? (previous?.priorTxHashes || []) : []),
      ...txHashes.slice(0, done),
    ],
  };
}
