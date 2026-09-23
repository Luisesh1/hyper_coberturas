const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/repositories/protection-decision-log.repository');

/**
 * El recorte por margen, registrado donde sobrevive a un rebuild.
 *
 * Desde el 2026-09-22 el preflight, en vez de rechazar entero un incremento que
 * el colateral no aguanta, lo recorta a lo que si cabe. Eso arreglo el modo de
 * fallo que dejo a pp24 siete dias con `actual_qty = 0.00010` contra un target
 * de 0.068.
 *
 * Pero el recorte solo iba a los logs del contenedor, que desaparecen en cada
 * despliegue. `execution_skipped_because` no sirve: describe un SALTO, y un
 * recorte es lo contrario — se ejecuto, solo que menos. El panel contaba
 * rechazos y era ciego a los recortes, justo durante la ventana de medicion de
 * la Fase 6.
 *
 * Los tres estados tienen que poder distinguirse:
 *
 *   ejecutado entero   margin_clamped_from_qty NULL  · skipped NULL
 *   recortado          margin_clamped_from_qty valor · skipped NULL
 *   rechazado          margin_clamped_from_qty NULL  · skipped motivo
 */

function fakeExecutor() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 1 }] };
    },
  };
}

const BASE = {
  protectedPoolId: 28,
  decision: 'range_exit_rebalance',
  targetQty: 0.0785,
  actualQty: 0.0642,
  currentPrice: 2760,
};

// Posicion de `margin_clamped_from_qty` en el INSERT, derivada de la lista de
// columnas en vez de hardcodeada: si alguien reordena, el test sigue valiendo.
function clampValue(call) {
  const cols = call.sql.slice(call.sql.indexOf('(') + 1, call.sql.indexOf(')'))
    .split(',').map((c) => c.trim());
  return call.params[cols.indexOf('margin_clamped_from_qty')];
}

test('un recorte guarda la cantidad PEDIDA, no la concedida', async () => {
  const exec = fakeExecutor();
  // pp24 el 09-04: hacian falta 0.068 y el colateral solo daba para 0.031.
  await repo.create({ ...BASE, targetQty: 0.031, marginClampedFromQty: 0.068 }, exec);

  assert.equal(clampValue(exec.calls[0]), 0.068);
  // Lo concedido ya vive en `target_qty`; la diferencia es lo que falto.
  const cols = exec.calls[0].sql.slice(exec.calls[0].sql.indexOf('(') + 1, exec.calls[0].sql.indexOf(')'))
    .split(',').map((c) => c.trim());
  assert.equal(exec.calls[0].params[cols.indexOf('target_qty')], 0.031);
});

test('sin recorte la columna queda nula, no en cero', async () => {
  const exec = fakeExecutor();
  await repo.create(BASE, exec);

  assert.equal(clampValue(exec.calls[0]), null, 'un 0 se leeria como "se recorto a nada"');
});

test('los tres estados de ejecucion se distinguen entre si', async () => {
  const exec = fakeExecutor();

  await repo.create({ ...BASE }, exec);                                              // entero
  await repo.create({ ...BASE, marginClampedFromQty: 0.068 }, exec);                  // recortado
  await repo.create({ ...BASE, executionSkippedBecause: 'insufficient_margin' }, exec); // rechazado

  const cols = exec.calls[0].sql.slice(exec.calls[0].sql.indexOf('(') + 1, exec.calls[0].sql.indexOf(')'))
    .split(',').map((c) => c.trim());
  const skipped = (i) => exec.calls[i].params[cols.indexOf('execution_skipped_because')];

  assert.deepEqual(
    [[clampValue(exec.calls[0]), skipped(0)],
      [clampValue(exec.calls[1]), skipped(1)],
      [clampValue(exec.calls[2]), skipped(2)]],
    [[null, null], [0.068, null], [null, 'insufficient_margin']],
  );
});

test('la lectura devuelve el recorte como numero, no como texto', async () => {
  // La columna es NUMERIC y pg la entrega como string; sin conversion, el panel
  // sumaria concatenando.
  const exec = {
    query: async () => ({ rows: [{ id: 1, marginClampedFromQty: '0.068', targetQty: '0.031' }] }),
  };
  const [fila] = await repo.listByProtectedPoolId(28, {}, exec);

  assert.equal(typeof fila.marginClampedFromQty, 'number');
  assert.equal(fila.marginClampedFromQty, 0.068);
});

test('una fila sin recorte se lee como null y no como NaN', async () => {
  const exec = {
    query: async () => ({ rows: [{ id: 1, marginClampedFromQty: null }] }),
  };
  const [fila] = await repo.listByProtectedPoolId(28, {}, exec);

  assert.equal(fila.marginClampedFromQty, null);
});
