/**
 * Politica de cobertura por BORDE DE RANGO (`range_exit_v1`).
 *
 * Idea: cubrir el 100% del delta al abrir y NO volver a tocar el hedge
 * mientras el precio siga dentro del rango del LP. Solo se rebalancea en dos
 * eventos: cuando el precio SALE del rango y cuando VUELVE a entrar.
 *
 * Por que el borde es el punto natural de rebalanceo, y no una eleccion
 * arbitraria: el delta de un LP concentrado solo cambia DENTRO del rango.
 * Fuera es constante — 0 por encima del borde superior (el LP quedo todo en
 * estable) y el maximo por debajo del inferior (quedo todo en volatil). O sea
 * la gamma se apaga justo en el borde. Rebalancear ahi es rebalancear donde el
 * ajuste es exacto y permanente hasta el proximo cruce, en vez de perseguir un
 * delta que se mueve.
 *
 * El intercambio, dicho sin adornos: dentro del rango la posicion queda con
 * gamma negativa sin cubrir. El LP es concavo en precio y un short estatico es
 * lineal, asi que la suma pierde con movimiento en cualquier direccion y gana
 * con quietud (mas las fees). Esta politica NO elimina ese coste: elige pagarlo
 * como divergencia en vez de como comisiones de rebalanceo. Es la apuesta
 * correcta cuando el coste de ejecucion domina a la volatilidad realizada
 * dentro del rango, y la equivocada cuando pasa lo contrario. Por eso nace en
 * sombra y se promueve con datos, no con opinion.
 *
 * Ojo con el parecido enganoso: esto NO es el viejo `zoneHedgeMultiplierCenter
 * = 0.6`. Aquel sub-cubria de forma PERMANENTE un 40% del delta, asi que en
 * tendencia el hueco solo crecia. Aqui se abre en 1.0 y la divergencia arranca
 * en cero, es simetrica alrededor del punto de apertura, y el cruce de borde le
 * pone un techo. Se parecen en la forma (menos cobertura en el centro) y se
 * diferencian en lo que importa (el sesgo y el tope).
 */
const {
  ESTIMATED_TAKER_FEE_RATE,
  DEFAULT_MIN_ORDER_NOTIONAL_USD,
} = require('./protected-pool-delta-neutral.helpers');

const RANGE_EXIT_V1 = 'range_exit_v1';

// Confirmacion temporal del cruce, en linea con `UPPER_HYSTERESIS_CONFIRM_MS`
// de la politica net_profit: una mecha que pincha el borde y vuelve no es una
// salida del rango.
const CROSS_CONFIRM_MS = 120_000;

// Limites del corrimiento del trigger. El valor se DERIVA del coste (ver
// `resolveTriggerOffsetPct`); esto solo evita los dos extremos degenerados:
// un offset de 0 (que devuelve el whipsaw que la histeresis viene a matar) y
// uno tan ancho que la cobertura llegue tarde a un movimiento real.
const MIN_TRIGGER_OFFSET_PCT = 0.0015; // 0.15%
const MAX_TRIGGER_OFFSET_PCT = 0.02;   // 2%

// Cuantas veces el coste de ida y vuelta debe cubrir el movimiento antes de
// que valga la pena cruzar. 2 = el viaje tiene que pagar el doble de lo que
// cuesta, que es el mismo espiritu del `x3` de la banda cost-aware legacy pero
// medido sobre el ajuste del borde, no sobre el drift instantaneo.
const COST_COVERAGE_MULTIPLE = 2;

// Cuanto puede alejarse el short REAL del ultimo target que esta politica
// mando antes de considerar que esa orden no aterrizo. Cubre el redondeo del
// exchange (szDecimals) sin tapar un llenado parcial.
const COMMIT_TOLERANCE_PCT = 0.02;

// Piso absoluto de esa tolerancia: solo ruido de coma flotante, nada que
// represente cobertura real.
const RESIDUAL_QTY = 1e-8;

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clave estable del rango vigente. Si el orquestador re-centra el LP, cambia
 * la clave y la politica re-ancla: un rango nuevo es una apertura nueva, y
 * arrastrar el estado del anterior dejaria el hedge anclado a un borde que ya
 * no existe.
 */
function rangeKey(rangeLowerPrice, rangeUpperPrice) {
  const lower = finite(rangeLowerPrice);
  const upper = finite(rangeUpperPrice);
  if (!(lower > 0 && upper > lower)) return null;
  return `${lower.toFixed(8)}:${upper.toFixed(8)}`;
}

function resolveZone(price, lower, upper) {
  if (price >= upper) return 'above';
  if (price <= lower) return 'below';
  return 'inside';
}

/**
 * Corrimiento del trigger, derivado del coste de ida y vuelta.
 *
 * El pedido original fue "correr un poco el trigger para cubrir comisiones".
 * La forma honesta de elegir ese "poco" es preguntarle al coste. Cruzar el
 * borde implica un ajuste de `adjustQty` y volver a entrar implica deshacerlo,
 * asi que el viaje redondo cuesta ~2x la comision de ese ajuste. Se pide que el
 * movimiento mas alla del borde le gane a ese coste con margen:
 *
 *     adjustQty * movimiento >= COST_COVERAGE_MULTIPLE * 2 * comision(adjustQty)
 *
 * Y aqui aparece el resultado que importa: la comision de Hyperliquid es
 * puramente proporcional al notional (`size * price * rate`, sin componente
 * fija), asi que al despejar el movimiento **`adjustQty` se cancela**. El
 * offset de equilibrio NO depende del tamano del ajuste:
 *
 *     offsetPct = 2 * COST_COVERAGE_MULTIPLE * takerFeeRate
 *
 * Con el taker en 0.00025 eso da 0.10%. Se deja escrito asi, como una funcion
 * de la tasa y no de la cantidad, porque una version que recibiera `adjustQty`
 * para despues ignorarlo aparentaria una sofisticacion que no tiene. Si algun
 * dia el coste gana una parte fija (gas, piso de notional), la cancelacion se
 * rompe y ESTE es el lugar donde hay que volver a meter el tamano.
 *
 * Los clamps no son el mecanismo, son la red: protegen de una tasa corrupta o
 * de un 0 que devolveria el ping-pong que la histeresis viene a matar.
 */
function resolveTriggerOffsetPct({ takerFeeRate = ESTIMATED_TAKER_FEE_RATE } = {}) {
  const rate = finite(takerFeeRate, ESTIMATED_TAKER_FEE_RATE);
  if (!(rate > 0)) return MIN_TRIGGER_OFFSET_PCT;
  const offsetPct = 2 * COST_COVERAGE_MULTIPLE * rate;
  return Math.min(MAX_TRIGGER_OFFSET_PCT, Math.max(MIN_TRIGGER_OFFSET_PCT, offsetPct));
}

/**
 * Decide un tick de `range_exit_v1`.
 *
 * @param {object}  p
 * @param {number}  p.deltaQty          Delta del LP ahora (qty volatil equivalente).
 * @param {number}  p.actualQty         Short vigente de esta politica.
 * @param {number}  p.currentPrice
 * @param {number}  p.rangeLowerPrice
 * @param {number}  p.rangeUpperPrice
 * @param {object}  p.state             policyState persistido de la politica.
 * @param {number}  p.now
 * @param {boolean} p.forceRebalance    Forzado del orquestador (se respeta).
 * @param {number}  p.takerFeeRate      Tasa taker que fija el corrimiento del trigger.
 * @returns {{decision,gate,targetQty,adjustQty,nextState,...}}
 */
function decideRangeExitV1({
  deltaQty,
  actualQty = 0,
  currentPrice,
  rangeLowerPrice,
  rangeUpperPrice,
  state = {},
  now = Date.now(),
  forceRebalance = false,
  takerFeeRate = ESTIMATED_TAKER_FEE_RATE,
  minOrderNotionalUsd = DEFAULT_MIN_ORDER_NOTIONAL_USD,
} = {}) {
  const delta = Math.max(0, finite(deltaQty, 0));
  const held = Math.max(0, finite(actualQty, 0));
  const price = finite(currentPrice, 0);
  const lower = finite(rangeLowerPrice, 0);
  const upper = finite(rangeUpperPrice, 0);

  const prior = state && typeof state === 'object' ? state : {};
  const key = rangeKey(lower, upper);

  const hold = (gate, nextState = prior, extra = {}) => ({
    policyVersion: RANGE_EXIT_V1,
    decision: 'hold',
    gate,
    targetQty: held,
    adjustQty: 0,
    errorQty: 0,
    minNotionalUsd: null,
    nextState,
    ...extra,
  });

  const rebalance = (gate, nextState, extra = {}) => ({
    policyVersion: RANGE_EXIT_V1,
    decision: 'rebalance',
    gate,
    targetQty: delta,
    adjustQty: delta - held,
    errorQty: delta - held,
    minNotionalUsd: null,
    nextState: {
      ...nextState,
      lastRebalanceAt: now,
      lastSnapshotPrice: price,
      // Lo que esta politica ORDENO. Es la referencia contra la que el tick
      // siguiente comprueba si la orden llego a ejecutarse.
      committedTargetQty: delta,
    },
    ...extra,
  });

  // Sin rango utilizable no hay politica de borde que valga: se queda quieta en
  // vez de inventar un ancla. Es el unico caso en que devuelve `hold` sin
  // haber mirado el precio.
  if (!key || !(price > 0)) return hold('range_unavailable');

  const zone = resolveZone(price, lower, upper);

  // --- Anclaje: apertura, o re-centrado del rango --------------------------
  // Cubre el 100% del delta y fija el ancla. La ausencia de `rangeKey` es la
  // apertura en frio y un `rangeKey` distinto es el re-centrado del LP; ambos
  // caen en la misma comparacion.
  //
  // NO se usa `held <= 0` como senal de apertura, aunque lo parezca: por
  // encima del borde superior el LP queda todo en estable, el delta es 0 y una
  // posicion en cero es el estado CORRECTO de esta politica. Confundirlos hacia
  // que, estando fuera del rango y correctamente plana, se re-anclara en cada
  // tick. Lo detecto el test `fuera del rango se queda quieta`.
  if (prior.rangeKey !== key) {
    return rebalance(
      prior.rangeKey && prior.rangeKey !== key ? 'range_rebased' : 'initial_full_hedge',
      { ...prior, rangeKey: key, zone, crossPendingZone: null, crossStartedAt: null },
    );
  }

  // Un forzado del orquestador manda sobre la maquina de estados, igual que en
  // las otras politicas.
  if (forceRebalance) {
    return rebalance('forced', { ...prior, rangeKey: key, zone, crossPendingZone: null, crossStartedAt: null });
  }

  const anchoredZone = prior.zone || zone;

  // --- Dentro de la misma zona: no se toca nada ----------------------------
  // Este es el corazon de la politica y la razon por la que existe: entre dos
  // cruces no hay ni una sola orden.
  if (zone === anchoredZone) {
    // --- La orden anterior, ¿aterrizo? ------------------------------------
    //
    // El motor persiste el estado de esta maquina al DECIDIR, no al ejecutar
    // (`evaluate.js`: el estado se guarda antes del preflight y la ejecucion
    // puede abortarse despues). Y este `hold` es absorbente: si la zona ya
    // coincide, no se vuelve a mirar hasta el proximo cruce de borde. La suma
    // de las dos cosas dejaba el hedge varado con una sola orden bloqueada.
    //
    // Pasó de verdad, en pp24 (2026-09-15/18):
    //
    //   18:47  cae bajo el rango, ordena 0.12406 -> llena solo 0.08490
    //   18:55  reentra, ordena 0.11435 -> insufficient_margin
    //   ...    47 h dentro del rango, target 0.0516, short clavado en 0.08490
    //
    // La zona ya decia `inside`, asi que nunca reintento. Lo mismo estrandaba
    // un LP re-centrado: `range_rebased` movia el `rangeKey`, la orden se
    // bloqueaba, y el hedge se quedaba en cero para siempre.
    //
    // Se compara contra el target ORDENADO, no contra el delta: la politica
    // sigue sin perseguir el delta dentro del rango —esa divergencia es el
    // punto— pero deja de tolerar su propia orden sin cumplir.
    // La tolerancia es relativa al target, con un piso absoluto para que el
    // ruido de coma flotante no cuente como orden incumplida. Con `committed`
    // en 0 —por encima del borde superior— el piso es lo unico que queda, y
    // ahi cualquier residuo SI debe reintentarse: cerrar del todo es la unica
    // orden sub-minimo que Hyperliquid acepta.
    const committed = finite(prior.committedTargetQty);
    const commitGap = committed == null ? 0 : Math.abs(held - committed);
    const commitTolerance = Math.max(Math.abs(committed || 0) * COMMIT_TOLERANCE_PCT, RESIDUAL_QTY);
    if (committed != null && commitGap > commitTolerance) {
      // Reintentar lo que el exchange no puede aceptar es gritar sobre algo
      // irreparable: la orden se rechaza, no se mueve capital, la cobertura no
      // mejora, y cada intento gasta una alerta. pp24 arrastraba justo eso —
      // 0.00546 pedido contra 0.00280 vivo, $7 sobre un minimo de $11.
      //
      // La excepcion es cerrar del todo: Hyperliquid SI acepta un reduceOnly
      // sub-minimo cuando deja la posicion en cero, y es la unica via de sacar
      // un residuo. Sin esta rama, un resto de 1e-4 por encima del borde se
      // quedaria puesto para siempre.
      const isFullClose = delta <= RESIDUAL_QTY && held > RESIDUAL_QTY;
      const minNotional = Math.max(0, finite(minOrderNotionalUsd, DEFAULT_MIN_ORDER_NOTIONAL_USD));
      if (isFullClose || commitGap * price >= minNotional) {
        return rebalance('commit_incomplete', {
          ...prior,
          rangeKey: key,
          zone,
          crossPendingZone: null,
          crossStartedAt: null,
        });
      }
      // Hay una orden sin cumplir, pero no se puede enviar. Se nombra distinto
      // de `inside_range_hold` a proposito: por fuera se parecen, y confundir
      // "todo en orden" con "pendiente e inejecutable" es como se pierden estas
      // cosas de vista.
      return hold('commit_below_min_notional', prior, { commitGapUsd: commitGap * price });
    }
    // Si habia un cruce a medio confirmar y el precio volvio, se descarta.
    if (prior.crossPendingZone) {
      return hold('cross_aborted', { ...prior, crossPendingZone: null, crossStartedAt: null });
    }
    return hold(zone === 'inside' ? 'inside_range_hold' : 'outside_range_hold');
  }

  // --- Cambio de zona: histeresis + confirmacion temporal ------------------
  // El borde que se esta cruzando y hacia donde. El offset se aplica SIEMPRE
  // en el sentido que hace mas dificil el cruce, tanto al salir como al
  // reentrar: esa asimetria es la que evita el ping-pong en el borde.
  let boundaryPrice;
  let triggerPrice;
  let crossed;

  if (anchoredZone === 'inside') {
    // Saliendo: hay que superar el borde MAS un margen.
    boundaryPrice = zone === 'above' ? upper : lower;
    const offsetPct = resolveTriggerOffsetPct({ takerFeeRate });
    triggerPrice = zone === 'above'
      ? boundaryPrice * (1 + offsetPct)
      : boundaryPrice * (1 - offsetPct);
    crossed = zone === 'above' ? price >= triggerPrice : price <= triggerPrice;
  } else {
    // Reentrando: hay que meterse DENTRO del rango pasando el borde menos un
    // margen, no basta con tocarlo por fuera.
    boundaryPrice = anchoredZone === 'above' ? upper : lower;
    const offsetPct = resolveTriggerOffsetPct({ takerFeeRate });
    triggerPrice = anchoredZone === 'above'
      ? boundaryPrice * (1 - offsetPct)
      : boundaryPrice * (1 + offsetPct);
    crossed = anchoredZone === 'above' ? price <= triggerPrice : price >= triggerPrice;
  }

  if (!crossed) {
    return hold('trigger_offset_not_reached', { ...prior, crossPendingZone: null, crossStartedAt: null }, { triggerPrice });
  }

  // Confirmacion temporal: el precio tiene que SOSTENERSE del otro lado.
  const pending = prior.crossPendingZone === zone ? finite(prior.crossStartedAt) : null;
  if (pending == null) {
    return hold('cross_confirming', { ...prior, crossPendingZone: zone, crossStartedAt: now }, { triggerPrice });
  }
  if (now - pending < CROSS_CONFIRM_MS) {
    return hold('cross_confirming', prior, { triggerPrice });
  }

  return rebalance(
    anchoredZone === 'inside' ? 'range_exit' : 'range_reentry',
    { ...prior, rangeKey: key, zone, crossPendingZone: null, crossStartedAt: null },
    { triggerPrice },
  );
}

module.exports = {
  RANGE_EXIT_V1,
  CROSS_CONFIRM_MS,
  MIN_TRIGGER_OFFSET_PCT,
  MAX_TRIGGER_OFFSET_PCT,
  COST_COVERAGE_MULTIPLE,
  COMMIT_TOLERANCE_PCT,
  rangeKey,
  resolveZone,
  resolveTriggerOffsetPct,
  decideRangeExitV1,
};
