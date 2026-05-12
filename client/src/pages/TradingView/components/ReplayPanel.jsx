import { useEffect, useMemo, useState } from 'react';
import { getLowerTimeframes, defaultLowerTimeframe, pickRandomAnchor } from '../replay/replayUtils';
import styles from '../TradingViewPage.module.css';

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16];

// Convierte ms a "YYYY-MM-DDTHH:mm" en hora local (formato esperado por datetime-local).
function toDatetimeLocal(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Timestamp aleatorio por defecto: 30..180 días atrás.
function defaultRandomAnchor() {
  const now = Date.now();
  return pickRandomAnchor(now - 365 * 86_400_000, now);
}

export default function ReplayPanel({
  open,
  onClose,
  htfTimeframe,
  controller,
}) {
  const candidates = useMemo(() => getLowerTimeframes(htfTimeframe), [htfTimeframe]);
  const [draftSubTf, setDraftSubTf] = useState(() => defaultLowerTimeframe(htfTimeframe));
  const [draftAnchorMs, setDraftAnchorMs] = useState(() => defaultRandomAnchor());

  // Si cambia la HTF, recalcula el sub-TF por defecto si la actual ya no es válida.
  useEffect(() => {
    setDraftSubTf((prev) => (candidates.includes(prev) ? prev : defaultLowerTimeframe(htfTimeframe)));
  }, [htfTimeframe, candidates]);

  if (!open) return null;

  const noLowerAvailable = candidates.length === 0;

  const handleStart = () => {
    if (!draftSubTf) return;
    controller.start({ anchor: draftAnchorMs, subTf: draftSubTf });
  };
  const handleRandom = () => setDraftAnchorMs(defaultRandomAnchor());
  const handlePickerChange = (e) => {
    const ms = fromDatetimeLocal(e.target.value);
    if (ms != null) setDraftAnchorMs(ms);
  };

  return (
    <div className={styles.replayPanel} role="dialog" aria-label="Modo Replay">
      <div className={styles.replayHeader}>
        <span className={styles.replayTitle}>
          <span className={styles.replayDot} aria-hidden="true" />
          Replay {controller.active ? '(activo)' : ''}
        </span>
        <button
          type="button"
          className={styles.replayCloseBtn}
          onClick={() => {
            if (controller.active) controller.stop();
            onClose?.();
          }}
          aria-label="Cerrar replay"
          title="Cerrar"
        >×</button>
      </div>

      {noLowerAvailable && (
        <div className={styles.replayWarn}>
          La temporalidad <b>{htfTimeframe}</b> no admite sub-temporalidades menores. Cambia a 5m, 15m, 1h, 4h, 1D, 1W o 1M.
        </div>
      )}

      <div className={styles.replayRow}>
        <label className={styles.replayLabel}>Sub-TF:</label>
        <select
          className={styles.select}
          value={draftSubTf || ''}
          onChange={(e) => setDraftSubTf(e.target.value)}
          disabled={controller.active || noLowerAvailable}
        >
          {candidates.map((tf) => (
            <option key={tf} value={tf}>{tf}</option>
          ))}
        </select>
      </div>

      <div className={styles.replayRow}>
        <label className={styles.replayLabel}>Anchor:</label>
        <input
          type="datetime-local"
          className={styles.replayDatetime}
          value={toDatetimeLocal(draftAnchorMs)}
          onChange={handlePickerChange}
          disabled={controller.active}
        />
        <button
          type="button"
          className={styles.replayMiniBtn}
          onClick={handleRandom}
          disabled={controller.active}
          title="Anchor aleatorio"
        >🎲</button>
      </div>

      <div className={styles.replayRow}>
        {!controller.active ? (
          <button
            type="button"
            className={styles.replayPrimaryBtn}
            onClick={handleStart}
            disabled={noLowerAvailable || controller.loading}
          >
            {controller.loading ? 'Cargando…' : '▶ Iniciar'}
          </button>
        ) : (
          <>
            {controller.paused ? (
              <button
                type="button"
                className={styles.replayPrimaryBtn}
                onClick={controller.play}
                title="Reproducir"
              >▶ Play</button>
            ) : (
              <button
                type="button"
                className={styles.replayPrimaryBtn}
                onClick={controller.pause}
                title="Pausar"
              >⏸ Pause</button>
            )}
            <button
              type="button"
              className={styles.replayMiniBtn}
              onClick={controller.step}
              title="Avanzar 1 sub-vela"
              disabled={!controller.paused}
            >⏭</button>
            <button
              type="button"
              className={styles.replayMiniBtn}
              onClick={controller.reset}
              title="Volver al anchor original"
            >↺</button>
            <button
              type="button"
              className={styles.replayDangerBtn}
              onClick={() => controller.stop()}
              title="Salir del modo replay"
            >⏹</button>
          </>
        )}
      </div>

      <div className={styles.replayRow}>
        <label className={styles.replayLabel}>Velocidad:</label>
        <div className={styles.replaySpeedGroup}>
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.replaySpeedBtn} ${controller.speed === s ? styles.replaySpeedBtnActive : ''}`}
              onClick={() => controller.setSpeed(s)}
              title={`${s}× (1 sub-vela cada ${Math.round(1000 / s)}ms)`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {controller.active && controller.progress.htfBucket && (
        <div className={styles.replayStatus}>
          HTF: {new Date(controller.progress.htfBucket).toLocaleString(undefined, {
            month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
          })}
          {controller.progress.ltfTime && (
            <>
              {' • '}LTF: {new Date(controller.progress.ltfTime).toLocaleString(undefined, {
                month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
