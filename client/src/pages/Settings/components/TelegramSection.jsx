import { useState, useEffect } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import styles from './TelegramSection.module.css';

export function TelegramSection() {
  const { addNotification } = useTradingContext();
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    settingsApi.get()
      .then((d) => {
        const tg = d?.telegram || {};
        setToken(tg.token || '');
        setChatId(tg.chatId || '');
        setEnabled(tg.enabled || false);
      })
      .catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!token.trim() || !chatId.trim()) {
      addNotification('error', 'Token y Chat ID son obligatorios');
      return;
    }
    setSaving(true);
    try {
      await settingsApi.saveTelegram({ token: token.trim(), chatId: chatId.trim() });
      setEnabled(true);
      addNotification('success', 'Configuracion Telegram guardada');
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      await settingsApi.testTelegram();
      addNotification('success', 'Mensaje de prueba enviado');
    } catch (err) {
      addNotification('error', err.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Notificaciones Telegram</h2>
        <p className={styles.subtitle}>
          Recibe alertas cuando se crea, activa o cierra una cobertura.
          Crea un bot en <strong>@BotFather</strong> y obten tu Chat ID con <strong>@userinfobot</strong>.
        </p>
      </div>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label}>Bot Token</label>
            <input
              className={styles.input}
              type="password"
              placeholder="123456:ABC-DEF..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Chat ID</label>
            <input
              className={styles.input}
              type="text"
              placeholder="-1001234567890"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              autoComplete="off"
            />
            <span className={styles.hint}>ID de tu chat o grupo (puede ser negativo)</span>
          </div>
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar configuracion'}
          </button>
          <button type="button" className={styles.testBtn} disabled={!enabled || testing} onClick={handleTest}>
            {testing ? 'Enviando…' : 'Enviar prueba'}
          </button>
        </div>
      </form>
    </div>
  );
}
