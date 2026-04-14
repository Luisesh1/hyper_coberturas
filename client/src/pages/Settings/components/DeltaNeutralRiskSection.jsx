import { useEffect, useState } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import styles from './EtherscanSection.module.css';

export function DeltaNeutralRiskSection({ onStatusChange }) {
  const { addNotification } = useTradingContext();
  const [form, setForm] = useState({
    riskPauseLiqDistancePct: '',
    marginTopUpLiqDistancePct: '',
    maxAutoTopUpsPer24h: '',
    minAutoTopUpCapUsd: '',
    autoTopUpCapPctOfInitial: '',
    minAutoTopUpFloorUsd: '',
  });
  const [saving, setSaving] = useState(false);
  const [counters, setCounters] = useState([]);
  const [loadingCounters, setLoadingCounters] = useState(true);
  const [resettingProtectionId, setResettingProtectionId] = useState(null);

  async function loadCounters() {
    setLoadingCounters(true);
    try {
      const data = await settingsApi.getDeltaNeutralTopUpCounters();
      setCounters(Array.isArray(data) ? data : []);
    } catch {
      setCounters([]);
    } finally {
      setLoadingCounters(false);
    }
  }

  useEffect(() => {
    settingsApi.getDeltaNeutralRiskControls()
      .then((data) => {
        const nextForm = {
          riskPauseLiqDistancePct: String(data?.riskPauseLiqDistancePct ?? ''),
          marginTopUpLiqDistancePct: String(data?.marginTopUpLiqDistancePct ?? ''),
          maxAutoTopUpsPer24h: String(data?.maxAutoTopUpsPer24h ?? ''),
          minAutoTopUpCapUsd: String(data?.minAutoTopUpCapUsd ?? ''),
          autoTopUpCapPctOfInitial: String(data?.autoTopUpCapPctOfInitial ?? ''),
          minAutoTopUpFloorUsd: String(data?.minAutoTopUpFloorUsd ?? ''),
        };
        setForm(nextForm);
        onStatusChange?.(nextForm);
      })
      .catch(() => {});
    loadCounters().catch(() => {});
  }, [onStatusChange]);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSave(event) {
    event.preventDefault();
    const riskPauseLiqDistancePct = Number(form.riskPauseLiqDistancePct);
    const marginTopUpLiqDistancePct = Number(form.marginTopUpLiqDistancePct);
    const maxAutoTopUpsPer24h = Number(form.maxAutoTopUpsPer24h);
    const minAutoTopUpCapUsd = Number(form.minAutoTopUpCapUsd);
    const autoTopUpCapPctOfInitial = Number(form.autoTopUpCapPctOfInitial);
    const minAutoTopUpFloorUsd = Number(form.minAutoTopUpFloorUsd);

    if (!Number.isFinite(riskPauseLiqDistancePct) || riskPauseLiqDistancePct <= 0) {
      addNotification('error', 'El umbral de pausa por riesgo debe ser un numero positivo');
      return;
    }
    if (!Number.isFinite(marginTopUpLiqDistancePct) || marginTopUpLiqDistancePct <= 0) {
      addNotification('error', 'El umbral de auto top-up debe ser un numero positivo');
      return;
    }
    if (marginTopUpLiqDistancePct <= riskPauseLiqDistancePct) {
      addNotification('error', 'El auto top-up debe dispararse por encima de la pausa por riesgo');
      return;
    }
    if (!Number.isFinite(maxAutoTopUpsPer24h) || maxAutoTopUpsPer24h <= 0) {
      addNotification('error', 'El maximo de auto top-ups por 24h debe ser un numero positivo');
      return;
    }
    if (!Number.isFinite(minAutoTopUpCapUsd) || minAutoTopUpCapUsd <= 0) {
      addNotification('error', 'El cap minimo diario en USD debe ser un numero positivo');
      return;
    }
    if (!Number.isFinite(autoTopUpCapPctOfInitial) || autoTopUpCapPctOfInitial <= 0) {
      addNotification('error', 'El cap relativo al hedge inicial debe ser un porcentaje positivo');
      return;
    }
    if (!Number.isFinite(minAutoTopUpFloorUsd) || minAutoTopUpFloorUsd < 0) {
      addNotification('error', 'El piso minimo por top-up debe ser cero o mayor');
      return;
    }

    setSaving(true);
    try {
      const saved = await settingsApi.saveDeltaNeutralRiskControls({
        riskPauseLiqDistancePct,
        marginTopUpLiqDistancePct,
        maxAutoTopUpsPer24h,
        minAutoTopUpCapUsd,
        autoTopUpCapPctOfInitial,
        minAutoTopUpFloorUsd,
      });
      const nextForm = {
        riskPauseLiqDistancePct: String(saved.riskPauseLiqDistancePct),
        marginTopUpLiqDistancePct: String(saved.marginTopUpLiqDistancePct),
        maxAutoTopUpsPer24h: String(saved.maxAutoTopUpsPer24h),
        minAutoTopUpCapUsd: String(saved.minAutoTopUpCapUsd),
        autoTopUpCapPctOfInitial: String(saved.autoTopUpCapPctOfInitial),
        minAutoTopUpFloorUsd: String(saved.minAutoTopUpFloorUsd),
      };
      setForm(nextForm);
      onStatusChange?.(nextForm);
      addNotification('success', 'Umbrales de riesgo guardados');
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleResetCounter(protectionId) {
    setResettingProtectionId(protectionId);
    try {
      await settingsApi.resetDeltaNeutralTopUpCounter(protectionId);
      await loadCounters();
      addNotification('success', `Contadores reseteados para la proteccion #${protectionId}`);
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setResettingProtectionId(null);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Delta-neutral: riesgo</h2>
        <p className={styles.subtitle}>
          Ajusta los umbrales de distancia a liquidacion del hedge.
          <strong> El valor actual por defecto queda persistido en base de datos.</strong>
        </p>
      </div>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.field}>
          <label className={styles.label}>Pausar por riesgo si la distancia a liquidacion es menor o igual a (%)</label>
          <input
            className={styles.input}
            type="number"
            name="riskPauseLiqDistancePct"
            min="0.01"
            step="0.01"
            value={form.riskPauseLiqDistancePct}
            onChange={handleChange}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Intentar auto top-up si la distancia a liquidacion es menor o igual a (%)</label>
          <input
            className={styles.input}
            type="number"
            name="marginTopUpLiqDistancePct"
            min="0.01"
            step="0.01"
            value={form.marginTopUpLiqDistancePct}
            onChange={handleChange}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Maximo de auto top-ups por ventana de 24h</label>
          <input
            className={styles.input}
            type="number"
            name="maxAutoTopUpsPer24h"
            min="1"
            step="1"
            value={form.maxAutoTopUpsPer24h}
            onChange={handleChange}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Cap minimo diario de auto top-up (USD)</label>
          <input
            className={styles.input}
            type="number"
            name="minAutoTopUpCapUsd"
            min="0.01"
            step="0.01"
            value={form.minAutoTopUpCapUsd}
            onChange={handleChange}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Cap diario relativo al hedge inicial (%)</label>
          <input
            className={styles.input}
            type="number"
            name="autoTopUpCapPctOfInitial"
            min="0.01"
            step="0.01"
            value={form.autoTopUpCapPctOfInitial}
            onChange={handleChange}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Piso minimo por cada top-up (USD)</label>
          <input
            className={styles.input}
            type="number"
            name="minAutoTopUpFloorUsd"
            min="0"
            step="1"
            value={form.minAutoTopUpFloorUsd}
            onChange={handleChange}
          />
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar umbrales'}
          </button>
        </div>
      </form>

      <div className={styles.form}>
        <div className={styles.header}>
          <h3 className={styles.title}>Contadores de auto top-up</h3>
          <p className={styles.subtitle}>
            Puedes revisar la ventana actual de cada proteccion delta-neutral y resetearla manualmente si hace falta destrabar un caso puntual.
          </p>
        </div>

        {loadingCounters && <p className={styles.subtitle}>Cargando contadores…</p>}
        {!loadingCounters && counters.length === 0 && (
          <p className={styles.subtitle}>No hay protecciones delta-neutral activas para este usuario.</p>
        )}
        {!loadingCounters && counters.length > 0 && (
          <div className={styles.field}>
            {counters.map((counter) => (
              <div key={counter.protectionId} className={styles.counterCard}>
                <div className={styles.counterHeader}>
                  <div>
                    <div className={styles.label}>Proteccion #{counter.protectionId} · {counter.pair}</div>
                    <div className={styles.subtitle}>Activo: {counter.asset} · Estado: {counter.strategyStatus || counter.status}</div>
                  </div>
                  <button
                    type="button"
                    className={styles.testBtn}
                    onClick={() => handleResetCounter(counter.protectionId)}
                    disabled={resettingProtectionId === counter.protectionId}
                  >
                    {resettingProtectionId === counter.protectionId ? 'Reseteando…' : 'Resetear'}
                  </button>
                </div>
                <div className={styles.counterGrid}>
                  <div className={styles.counterItem}>
                    <span className={styles.label}>Conteo</span>
                    <strong className={styles.title}>{counter.topUpCount24h} / {counter.topUpMaxCount24h || '—'}</strong>
                  </div>
                  <div className={styles.counterItem}>
                    <span className={styles.label}>USD usados</span>
                    <strong className={styles.title}>${Number(counter.topUpUsd24h || 0).toFixed(2)} / ${Number(counter.topUpCapUsd || 0).toFixed(2)}</strong>
                  </div>
                </div>
                {counter.lastError && <p className={styles.subtitle}>Ultimo error: {counter.lastError}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
