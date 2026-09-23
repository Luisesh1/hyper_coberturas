const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveExposureMeasureUsd,
  resolveNakedNotionalCapUsd,
  resolveNakedNotionalBreach,
  resolveNakedExposure,
} = require('../src/services/protected-pool-delta-neutral.helpers');

/**
 * Que se mide como exposicion depende de la politica.
 *
 * El tope se alimentaba SIEMPRE de `|delta - actual|`. Para una politica que
 * persigue el delta eso es correcto: un hueco sostenido es una averia.
 *
 * Para `range_exit_v1` es al reves — ese hueco ES el producto. Medido en pp28
 * el 2026-09-23 con el LP en $519.81 y rango 2612-2858:
 *
 *   tope               max($30, 15% x 519.81) = $78
 *   divergencia diseno $224 (borde superior) … $315 (borde inferior)
 *
 * El tope saltaba a los 2722 —una caida del 1,2%— con el borde a 5,2%. Al 23%
 * del camino. La politica no llegaba a cruzar NUNCA: de 37 ejecuciones, cero
 * las decidio ella.
 *
 * Ensanchar el tope hasta lo que el rango explica no sirve: ese maximo es
 * practicamente el valor entero del LP, asi que seria quitar la red
 * disfrazandolo de calibrarla.
 *
 * Lo correcto no es cuanta divergencia, es divergencia RESPECTO A QUE:
 *
 *   |delta - actual|      lo que el mercado movio   -> producto en range_exit
 *   |committed - actual|  lo que la politica ORDENO -> averia en cualquiera
 */

const PRECIO = 2715.5;
const POOL = 519.81;

test('el episodio real de pp28 ya NO cuenta como exposicion', () => {
  // El tick que disparo el tope: delta 0.11047, short 0.0785. La politica lo
  // habia ordenado asi y su orden SI habia aterrizado.
  const usd = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.0785,
    deltaQty: 0.11047,
    committedTargetQty: 0.0785,
    currentPrice: PRECIO,
  });

  assert.ok(usd < 1, `su orden aterrizo: no hay averia (${usd.toFixed(2)})`);

  // Y por tanto el tope no interviene.
  const cap = resolveNakedNotionalCapUsd(null, POOL);
  const tras1h = resolveNakedExposure({
    nakedNotionalUsd: usd, poolValueUsd: POOL, now: 1e12,
  });
  assert.equal(
    resolveNakedNotionalBreach({ nakedNotionalUsd: usd, poolValueUsd: POOL, tier: tras1h.tier }).breached,
    false,
    'aqui es donde la politica perdia el control'
  );
  assert.ok(cap > 70 && cap < 80);
});

test('con la medida vieja ese mismo tick SI disparaba: la regresion', () => {
  const viejo = resolveExposureMeasureUsd({
    livePolicy: null,               // cualquier otra politica
    actualQty: 0.0785,
    deltaQty: 0.11047,
    committedTargetQty: 0.0785,
    currentPrice: PRECIO,
  });

  // (0.11047 - 0.0785) x 2715.5 = $86.8, por encima del tope de $78.
  assert.ok(viejo > 80);
  assert.ok(viejo > resolveNakedNotionalCapUsd(null, POOL));
});

test('una orden que NO aterrizo si cuenta como averia', () => {
  // Esto es lo que el tope debe seguir atrapando: la politica ordeno 0.11047 y
  // el short se quedo en 0.0785.
  const usd = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.0785,
    deltaQty: 0.11047,
    committedTargetQty: 0.11047,
    currentPrice: PRECIO,
  });

  assert.ok(usd > 80, `la orden no entro: eso si es averia (${usd.toFixed(2)})`);
  const tras1h = resolveNakedExposure({ nakedNotionalUsd: usd, poolValueUsd: POOL, now: 1e12 });
  const sostenida = resolveNakedExposure({
    nakedNotionalUsd: usd, poolValueUsd: POOL,
    now: 1e12 + 61 * 60_000, priorSince: tras1h.since, priorTier: tras1h.tier,
  });
  assert.equal(
    resolveNakedNotionalBreach({ nakedNotionalUsd: usd, poolValueUsd: POOL, tier: sostenida.tier }).breached,
    true,
    'la red sigue puesta para el fallo real'
  );
});

test('el caso de pp27 seguiria atrapandose', () => {
  // Short desnudo con el delta ya en cero: la politica habria ordenado cerrar,
  // y el short seguiria abierto. Esa es la averia que costo 72 h y $53.90.
  const usd = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.0226,
    deltaQty: 0,
    committedTargetQty: 0,
    currentPrice: 2385,
  });

  assert.ok(usd > 50, `$${usd.toFixed(2)} de short que nadie cerro`);
});

test('las demas politicas no cambian de medida', () => {
  for (const politica of [null, 'net_profit_v2', 'legacy_zones_v1']) {
    const usd = resolveExposureMeasureUsd({
      livePolicy: politica,
      actualQty: 0.08, deltaQty: 0.12, committedTargetQty: 0.08, currentPrice: 2500,
    });
    assert.equal(Number(usd.toFixed(2)), 100, `${politica} sigue midiendo contra el delta`);
  }
});

test('sin committedTargetQty se cae al comportamiento anterior', () => {
  // Protecciones anteriores al 2026-09-22 no tienen el campo. Sin referencia no
  // se puede juzgar mejor, asi que no se inventa una.
  const usd = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.08, deltaQty: 0.12, committedTargetQty: undefined, currentPrice: 2500,
  });

  assert.equal(Number(usd.toFixed(2)), 100);
});

test('la medida es simetrica: sobre-cubierto e infra-cubierto pesan igual', () => {
  const sobre = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.12, deltaQty: 0.12, committedTargetQty: 0.08, currentPrice: 2500,
  });
  const infra = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.08, deltaQty: 0.08, committedTargetQty: 0.12, currentPrice: 2500,
  });

  assert.equal(sobre, infra);
});
