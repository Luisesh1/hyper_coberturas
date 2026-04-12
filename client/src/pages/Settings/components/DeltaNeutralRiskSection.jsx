import { useEffect, useState } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import styles from './EtherscanSection.module.css';

export function DeltaNeutralRiskSection({ onStatusChange }) {
  const { addNotification } = useTradingContext();
  const [form, setForm] = useState({
    riskPauseLiqDistancePct: '',
    marginTopUpLiqDistancePct: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    settingsApi.getDeltaNeutralRiskControls()
      .then((data) => {
        const nextForm = {
          riskPauseLiqDistancePct: String(data?.riskPauseLiqDistancePct ?? ''),
          marginTopUpLiqDistancePct: String(data?.marginTopUpLiqDistancePct ?? ''),
        };
        setForm(nextForm);
        onStatusChange?.(nextForm);
      })
      .catch(() => {});
  }, [onStatusChange]);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSave(event) {
    event.preventDefault();
    const riskPauseLiqDistancePct = Number(form.riskPauseLiqDistancePct);
    const marginTopUpLiqDistancePct = Number(form.marginTopUpLiqDistancePct);

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

    setSaving(true);
    try {
      const saved = await settingsApi.saveDeltaNeutralRiskControls({
        riskPauseLiqDistancePct,
        marginTopUpLiqDistancePct,
      });
      const nextForm = {
        riskPauseLiqDistancePct: String(saved.riskPauseLiqDistancePct),
        marginTopUpLiqDistancePct: String(saved.marginTopUpLiqDistancePct),
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

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar umbrales'}
          </button>
        </div>
      </form>
    </div>
  );
}
