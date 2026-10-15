import { useEffect, useState } from 'react';
import Sheet from './common/Sheet';
import { SwitchField } from './common/Fields';
import { WarningIcon } from './common/icons';
import { isCredentialsError } from './strategyView';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

const STRATEGY_POINTS = [
  'Abre y cierra posiciones según sus reglas, evaluando cada 5 minutos.',
  'Respeta los límites de riesgo globales y los de la estrategia; si se supera alguno, no envía la orden.',
  'El modo sombra sigue corriendo en paralelo para comparar la ejecución.',
  'Puedes volver a Sombra o Pausada en cualquier momento; las posiciones abiertas no se cierran solas.',
];

// Confirmación explícita antes de pasar una estrategia (o un bot de trading
// automatizado) a modo Real. Sólo al aceptar se envía
// PUT /:id/mode { mode: 'live', confirm: true }.
export default function LiveConfirmDialog({
  open, strategy, submitting, error, onConfirm, onCancel,
  subject = 'La estrategia', points = STRATEGY_POINTS,
}) {
  const [ack, setAck] = useState(false);
  useEffect(() => { if (open) setAck(false); }, [open]);

  const credentials = error && isCredentialsError(error);

  return (
    <Sheet
      open={open}
      title="Activar modo Real"
      description={strategy ? `«${strategy.name}» · ${strategy.underlying || ''}` : undefined}
      tone="warning"
      size="sm"
      onClose={onCancel}
      closeDisabled={submitting}
      footer={(
        <>
          <button type="button" className={ui.btn} onClick={onCancel} disabled={submitting}>Cancelar</button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnWarn}`}
            onClick={onConfirm}
            disabled={!ack || submitting}
          >
            {submitting ? 'Activando…' : 'Activar Real'}
          </button>
        </>
      )}
    >
      <p className={`${ui.alert} ${ui.alertWarn}`}>
        <WarningIcon size={18} />
        <span>{subject} enviará <strong>órdenes reales</strong> a tu cuenta de Binance Opciones con tu dinero.</span>
      </p>
      <ul className={styles.confirmList}>
        {points.map((p) => <li key={p}>{p}</li>)}
      </ul>
      <div className={styles.confirmAck}>
        <SwitchField
          label="Entiendo que se enviarán órdenes reales"
          checked={ack}
          onChange={setAck}
          disabled={submitting}
        />
      </div>
      {error && (
        <p className={`${ui.alert} ${ui.alertError}`} role="alert">
          <span>
            {error.message || 'No se pudo activar el modo Real.'}
            {credentials && (
              <>
                {' '}
                <a href="/config">Configura tu API key en Configuración › Binance Opciones</a>.
              </>
            )}
          </span>
        </p>
      )}
    </Sheet>
  );
}
