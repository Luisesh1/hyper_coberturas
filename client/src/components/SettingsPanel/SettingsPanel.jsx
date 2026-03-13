/**
 * SettingsPanel.jsx
 *
 * Panel de configuración por usuario:
 *  - Wallet (private key + address)
 *  - Notificaciones Telegram
 */

import { useState, useEffect } from 'react';
import { settingsApi } from '../../services/api';
import styles from './SettingsPanel.module.css';

function useFeedback() {
  const [feedback, setFeedback] = useState(null);
  const show = (type, text) => {
    setFeedback({ type, text });
    setTimeout(() => setFeedback(null), 4000);
  };
  return [feedback, show];
}

// ── Sección: Wallet ─────────────────────────────────────────────────
function WalletSection() {
  const [address,    setAddress]    = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [hasPk,      setHasPk]      = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [feedback,   showFeedback]  = useFeedback();

  useEffect(() => {
    settingsApi.getWallet()
      .then((d) => { setAddress(d.address || ''); setHasPk(d.hasPrivateKey || false); })
      .catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!privateKey.trim() || !address.trim()) {
      showFeedback('error', 'Private key y address son obligatorios');
      return;
    }
    setSaving(true);
    try {
      await settingsApi.saveWallet({ privateKey: privateKey.trim(), address: address.trim() });
      setHasPk(true);
      setPrivateKey('');
      showFeedback('ok', 'Wallet guardada. Recarga si tienes coberturas activas.');
    } catch (err) {
      showFeedback('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>🔑</span>
        <h3 className={styles.sectionTitle}>Wallet de Trading</h3>
        <span className={hasPk ? styles.badgeOn : styles.badgeOff}>
          {hasPk ? 'Configurada' : 'Sin configurar'}
        </span>
      </div>

      <p className={styles.description}>
        Clave privada de la wallet que firma las órdenes en Hyperliquid.
        <strong> No se devuelve al leer.</strong>
      </p>

      <form className={styles.form} onSubmit={handleSave}>
        <div className={styles.field}>
          <label className={styles.label}>Wallet Address</label>
          <input
            className={styles.input}
            type="text"
            placeholder="0x..."
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Private Key {hasPk && <span className={styles.hint}>(dejar vacío para mantener la actual)</span>}</label>
          <input
            className={styles.input}
            type="password"
            placeholder={hasPk ? '••••••• (no cambia si está vacío)' : '0x...'}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
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
            {saving ? 'Guardando…' : 'Guardar wallet'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── Sección: Telegram ───────────────────────────────────────────────
function TelegramSection() {
  const [token,    setToken]    = useState('');
  const [chatId,   setChatId]   = useState('');
  const [enabled,  setEnabled]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [testing,  setTesting]  = useState(false);
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

function EtherscanSection() {
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

// ── Panel principal ─────────────────────────────────────────────────
export default function SettingsPanel() {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Configuración</h2>
          <p className={styles.subtitle}>Ajustes de wallet y notificaciones</p>
        </div>
      </div>
      <WalletSection />
      <TelegramSection />
      <EtherscanSection />
    </div>
  );
}
