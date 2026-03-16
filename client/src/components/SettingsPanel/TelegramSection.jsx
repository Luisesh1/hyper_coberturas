import { useState, useEffect } from 'react';
import { settingsApi } from '../../services/api';
import { useFeedback } from './useFeedback';
import styles from './SettingsPanel.module.css';

export function TelegramSection() {
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, showFeedback] = useFeedback();

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
      showFeedback('error', 'Token y Chat ID son obligatorios');
      return;
    }
    setSaving(true);
    try {
      await settingsApi.saveTelegram({ token: token.trim(), chatId: chatId.trim() });
      setEnabled(true);
      showFeedback('ok', 'Configuración guardada correctamente');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      await settingsApi.testTelegram();
      showFeedback('ok', 'Mensaje de prueba enviado');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>✉</span>
        <h3 className={styles.sectionTitle}>Notificaciones Telegram</h3>
        <span className={enabled ? styles.badgeOn : styles.badgeOff}>
          {enabled ? 'Activo' : 'Inactivo'}
        </span>
      </div>

      <p className={styles.description}>
        Recibe alertas cuando se crea, activa o cierra una cobertura.
        Crea un bot en <strong>@BotFather</strong> y obtén tu Chat ID con <strong>@userinfobot</strong>.
      </p>

      <form className={styles.form} onSubmit={handleSave}>
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

        {feedback && (
          <div className={feedback.type === 'ok' ? styles.feedbackOk : styles.feedbackError}>
            {feedback.type === 'ok' ? '✓' : '✗'} {feedback.text}
          </div>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar configuración'}
          </button>
          <button type="button" className={styles.testBtn} disabled={!enabled || testing} onClick={handleTest}>
            {testing ? 'Enviando…' : 'Enviar prueba'}
          </button>
        </div>
      </form>
    </section>
  );
}
