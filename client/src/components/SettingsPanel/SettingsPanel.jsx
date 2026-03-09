/**
 * SettingsPanel.jsx
 *
 * Panel de configuración de notificaciones Telegram.
 * Permite guardar token y chatId sin editar .env.
 */

import { useState, useEffect } from 'react';
import { settingsApi } from '../../services/api';
import styles from './SettingsPanel.module.css';

export default function SettingsPanel() {
  const [token,     setToken]     = useState('');
  const [chatId,    setChatId]    = useState('');
  const [enabled,   setEnabled]   = useState(false);
  const [isSaving,  setIsSaving]  = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [feedback,  setFeedback]  = useState(null); // { type: 'ok'|'error', text: string }

  // Cargar estado actual al montar
  useEffect(() => {
    settingsApi.get()
      .then(({ data }) => {
        const tg = data?.telegram || {};
        setToken(tg.token  || '');
        setChatId(tg.chatId || '');
        setEnabled(tg.enabled || false);
      })
      .catch(() => {});
  }, []);

  function showFeedback(type, text) {
    setFeedback({ type, text });
    setTimeout(() => setFeedback(null), 4000);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!token.trim() || !chatId.trim()) {
      showFeedback('error', 'Token y Chat ID son obligatorios');
      return;
    }
    setIsSaving(true);
    try {
      await settingsApi.saveTelegram({ token: token.trim(), chatId: chatId.trim() });
      setEnabled(true);
      showFeedback('ok', 'Configuración guardada correctamente');
    } catch (err) {
      showFeedback('error', err.message || 'Error al guardar');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTest() {
    setIsTesting(true);
    try {
      await settingsApi.testTelegram();
      showFeedback('ok', 'Mensaje de prueba enviado');
    } catch (err) {
      showFeedback('error', err.message || 'Error al enviar prueba');
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Configuración</h2>
          <p className={styles.subtitle}>Ajustes de notificaciones y conexión</p>
        </div>
      </div>

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
              spellCheck={false}
            />
            <span className={styles.hint}>
              Obtenido de @BotFather al crear el bot
            </span>
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
              spellCheck={false}
            />
            <span className={styles.hint}>
              ID de tu chat o grupo (puede ser negativo)
            </span>
          </div>

          {feedback && (
            <div className={feedback.type === 'ok' ? styles.feedbackOk : styles.feedbackError}>
              {feedback.type === 'ok' ? '✓' : '✗'} {feedback.text}
            </div>
          )}

          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.saveBtn}
              disabled={isSaving}
            >
              {isSaving ? 'Guardando…' : 'Guardar configuración'}
            </button>

            <button
              type="button"
              className={styles.testBtn}
              disabled={!enabled || isTesting}
              onClick={handleTest}
            >
              {isTesting ? 'Enviando…' : 'Enviar prueba'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
