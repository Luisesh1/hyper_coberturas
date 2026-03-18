import { useState, useEffect } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import styles from './EtherscanSection.module.css';

export function EtherscanSection() {
  const { addNotification } = useTradingContext();
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    settingsApi.getEtherscan()
      .then((d) => setHasApiKey(d.hasApiKey || false))
      .catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!apiKey.trim()) {
      addNotification('error', 'La API key es obligatoria');
      return;
    }
    setSaving(true);
    try {
      await settingsApi.saveEtherscan({ apiKey: apiKey.trim() });
      setHasApiKey(true);
      setApiKey('');
      addNotification('success', 'API key guardada correctamente');
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      await settingsApi.testEtherscan();
      addNotification('success', 'La API key responde correctamente');
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Etherscan API</h2>
        <p className={styles.subtitle}>
          API key personal para escanear pools creados por wallet en Uniswap.
          <strong> Se guarda cifrada y no se devuelve al leer.</strong>
        </p>
      </div>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.field}>
          <label className={styles.label}>
            API Key {hasApiKey && <span className={styles.labelHint}>(dejar vacio para mantener la actual)</span>}
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

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar API key'}
          </button>
          <button type="button" className={styles.testBtn} disabled={!hasApiKey || testing} onClick={handleTest}>
            {testing ? 'Probando…' : 'Probar key'}
          </button>
        </div>
      </form>
    </div>
  );
}
