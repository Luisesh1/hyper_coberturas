/**
 * Texto legible del resultado de `OptionsLiveExecution.submit` y si la
 * señal debe seguir pendiente (lo resolverán los fills al conciliar).
 * Lo comparten el runner (lo que produjo) y `decide` (la fila de la señal),
 * para que ninguna señal muestre códigos internos.
 */

// Resultados no finales: la orden pudo llegar a Binance y su lote enlazado
// resuelve la señal al conciliar los fills.
const PENDING_STATUSES = ['submitted', 'tp_cancel_requested', 'attention'];

const TEXT = {
  submitted: 'Orden límite enviada; ejecución pendiente',
  tp_cancel_requested: 'Cancelando el TP residente antes de cerrar',
  attention: 'Envío sin confirmar: se concilia con Binance antes de decidir',
  rejected: 'Binance rechazó la orden; no se abrió nada',
  deadline: 'La ventana de diez minutos expiró antes de enviar la orden',
  duplicate_or_unresolved: 'No se envió: la señal ya se procesó o hay otra orden real sin conciliar',
  disabled: 'Envío real deshabilitado',
};

function submitOutcomeText(status, error) {
  const base = TEXT[status];
  if (!base) return status ? `Resultado del envío: ${status}` : 'Resultado del envío desconocido';
  return status === 'rejected' && error ? `${base} (${error})` : base;
}

function isPendingSubmitStatus(status) {
  return PENDING_STATUSES.includes(status);
}

module.exports = { submitOutcomeText, isPendingSubmitStatus, SUBMIT_STATUSES: Object.keys(TEXT) };
