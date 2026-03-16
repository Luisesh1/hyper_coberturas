import { useState, useEffect } from 'react';
import { settingsApi } from '../../services/api';
import { useFeedback } from './useFeedback';
import styles from './SettingsPanel.module.css';

export function EtherscanSection() {
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, showFeedback] = useFeedback();

  useEffect(() => {
    settingsApi.getEtherscan()
      .then((d) => {
        setHasApiKey(d.hasApiKey || false);
      })
      .catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!apiKey.trim()) {
      showFeedback('error', 'La API key es obligatoria');
      return;
    }
    setSaving(true);
    try {
      await settingsApi.saveEtherscan({ apiKey: apiKey.trim() });
      setHasApiKey(true);
      setApiKey('');
      showFeedback('ok', 'API key guardada correctamente');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      await settingsApi.testEtherscan();
      showFeedback('ok', 'La API key responde correctamente');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>🧭</span>
        <h3 className={styles.sectionTitle}>Etherscan API</h3>
        <span className={hasApiKey ? styles.badgeOn : styles.badgeOff}>
          {hasApiKey ? 'Configurada' : 'Sin configurar'}
        </span>
      </div>

      <p className={styles.description}>
        API key personal para escanear pools creados por wallet en Uniswap.
        <strong> Se guarda cifrada y no se devuelve al leer.</strong>
      </p>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.field}>
          <label className={styles.label}>
            API Key {hasApiKey && <span className={styles.hint}>(dejar vacio para mantener la actual)</span>}
          </label>
          <input
            className={styles.input}
            type="password"
            placeholder={hasApiKey ? '••••••• (no cambia si esta vacio)' : 'NXKM...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>

        {feedback && (
          <div className={feedback.type === 'ok' ? styles.feedbackOk : styles.feedbackError}>
            {feedback.type === 'ok' ? '✓' : '✗'} {feedback.text}
          </div>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar API key'}
          </button>
          <button type="button" className={styles.testBtn} disabled={!hasApiKey || testing} onClick={handleTest}>
            {testing ? 'Probando…' : 'Probar key'}
          </button>
        </div>
      </form>
    </section>
  );
}
