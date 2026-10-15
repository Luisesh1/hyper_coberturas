import { useEffect, useState } from 'react';
import Sheet from './common/Sheet';
import { SwitchField } from './common/Fields';
import { WarningIcon } from './common/icons';
import { isCredentialsError } from './strategyView';
import ui from './common/ui.module.css';
import styles from './StrategiesTab.module.css';

// Confirmación explícita antes de pasar una estrategia a modo Real. Sólo al
// aceptar se envía PUT /:id/mode { mode: 'live', confirm: true }.
export default function LiveConfirmDialog({ open, strategy, submitting, error, onConfirm, onCancel }) {
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
        <span>La estrategia enviará <strong>órdenes reales</strong> a tu cuenta de Binance Opciones con tu dinero.</span>
      </p>
      <ul className={styles.confirmList}>
        <li>Abre y cierra posiciones según sus reglas, evaluando cada 5 minutos.</li>
        <li>Respeta los límites de riesgo globales y los de la estrategia; si se supera alguno, no envía la orden.</li>
        <li>El modo sombra sigue corriendo en paralelo para comparar la ejecución.</li>
        <li>Puedes volver a Sombra o Pausada en cualquier momento; las posiciones abiertas no se cierran solas.</li>
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
