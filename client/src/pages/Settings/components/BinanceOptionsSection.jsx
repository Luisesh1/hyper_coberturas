import { useEffect, useState } from 'react';
import { settingsApi } from '../../../services/api';
import { useTradingContext } from '../../../context/TradingContext';
import { useConfirmAction } from '../../../hooks/useConfirmAction';
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog';
import styles from './BinanceOptionsSection.module.css';

const CHECK_LABEL = { ok: 'Correcto', warn: 'Aviso', fail: 'Fallo' };

const EMPTY_LIMITS = { maxMarginUsdt: '', maxDailyLossUsdt: '', maxLiveStrategies: '', notifyTelegram: true };

function limitsToForm(d) {
  if (!d) return EMPTY_LIMITS;
  const str = (v) => (v == null ? '' : String(v));
  return {
    maxMarginUsdt: str(d.maxMarginUsdt),
    maxDailyLossUsdt: str(d.maxDailyLossUsdt),
    maxLiveStrategies: str(d.maxLiveStrategies),
    notifyTelegram: d.notifyTelegram !== false,
  };
}

// Acepta «5000», «5000.5» y el formato español «5.000,5».
function parseAmount(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Estado global de la conexión a partir de la última prueba.
function statusOf(configured, checks) {
  if (!configured) return { tone: 'off', label: 'Sin configurar' };
  if (!checks) return { tone: 'idle', label: 'Configurada · sin probar' };
  if (checks.some((c) => c.status === 'fail')) return { tone: 'fail', label: 'Error de conexión' };
  if (checks.some((c) => c.status === 'warn')) return { tone: 'warn', label: 'Conectada · con avisos' };
  return { tone: 'ok', label: 'Conectada · lectura y trading' };
}

/**
 * Configuración › Binance Opciones: credenciales (una cuenta por usuario),
 * prueba de conexión y límites globales del módulo.
 * `onStatusChange({ configured, alias })` refresca el badge del sidebar.
 */
export function BinanceOptionsSection({ onStatusChange }) {
  const { addNotification } = useTradingContext();
  const { dialog, confirm } = useConfirmAction();

  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [form, setForm] = useState({ alias: '', apiKey: '', apiSecret: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState(null);
  const [error, setError] = useState(null);

  const [limits, setLimits] = useState(EMPTY_LIMITS);
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitsError, setLimitsError] = useState(null);

  useEffect(() => {
    let alive = true;
    settingsApi.getBinanceOptions()
      .then((d) => {
        if (!alive) return;
        setConfigured(!!d?.configured);
        setApiKeyMasked(d?.apiKeyMasked || '');
        setForm((f) => ({ ...f, alias: d?.alias || '' }));
      })
      .catch((err) => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoaded(true); });
    settingsApi.getOptionsLimits()
      .then((d) => { if (alive) setLimits(limitsToForm(d)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const setField = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    const alias = form.alias.trim();
    const apiKey = form.apiKey.trim();
    const apiSecret = form.apiSecret.trim();
    if (!configured && (!apiKey || !apiSecret)) {
      setError('La API key y el secret son obligatorios.');
      return;
    }
    setSaving(true);
    try {
      // Al editar, los campos vacíos conservan lo guardado.
      await settingsApi.saveBinanceOptions({
        alias: alias || undefined,
        apiKey: apiKey || undefined,
        apiSecret: apiSecret || undefined,
      });
      const d = await settingsApi.getBinanceOptions().catch(() => null);
      setConfigured(true);
      setApiKeyMasked(d?.apiKeyMasked || apiKeyMasked);
      setForm({ alias: d?.alias ?? alias, apiKey: '', apiSecret: '' });
      setChecks(null);
      onStatusChange?.({ configured: true, alias: d?.alias ?? alias });
      addNotification('success', 'Credenciales de Binance Opciones guardadas');
    } catch (err) {
      setError(err.message);
      addNotification('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    try {
      const d = await settingsApi.testBinanceOptions();
      setChecks(Array.isArray(d?.checks) ? d.checks : []);
    } catch (err) {
      setChecks(null);
      setError(err.message);
      addNotification('error', err.message);
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Eliminar credenciales',
      message: 'Se borrarán la API key y el secret de Binance Opciones. Las estrategias en modo real dejarán de poder operar.',
      confirmLabel: 'Eliminar',
    });
    if (!ok) return;
    setError(null);
    try {
      await settingsApi.deleteBinanceOptions();
      setConfigured(false);
      setApiKeyMasked('');
      setForm({ alias: '', apiKey: '', apiSecret: '' });
      setChecks(null);
      onStatusChange?.({ configured: false, alias: null });
      addNotification('success', 'Credenciales eliminadas');
    } catch (err) {
      setError(err.message);
      addNotification('error', err.message);
    }
  }

  async function handleSaveLimits(e) {
    e.preventDefault();
    setLimitsError(null);
    const maxMarginUsdt = parseAmount(limits.maxMarginUsdt);
    const maxDailyLossUsdt = parseAmount(limits.maxDailyLossUsdt);
    const maxLiveStrategies = parseAmount(limits.maxLiveStrategies);
    if (maxMarginUsdt == null || maxDailyLossUsdt == null || maxLiveStrategies == null) {
      setLimitsError('Los tres límites deben ser números mayores o iguales que 0.');
      return;
    }
    if (!Number.isInteger(maxLiveStrategies)) {
      setLimitsError('Las estrategias reales simultáneas deben ser un número entero.');
      return;
    }
    setSavingLimits(true);
    try {
      const saved = await settingsApi.saveOptionsLimits({
        maxMarginUsdt,
        maxDailyLossUsdt,
        maxLiveStrategies,
        notifyTelegram: limits.notifyTelegram,
      });
      if (saved) setLimits(limitsToForm(saved));
      addNotification('success', 'Límites guardados');
    } catch (err) {
      setLimitsError(err.message);
      addNotification('error', err.message);
    } finally {
      setSavingLimits(false);
    }
  }

  const status = statusOf(configured, checks);
  const setLimit = (name) => (e) => setLimits((l) => ({ ...l, [name]: e.target.value }));

  return (
    <div className={styles.section}>
      <form className={styles.card} onSubmit={handleSave} aria-label="Credenciales de Binance Opciones">
        <div className={styles.cardHead}>
          <div className={styles.headText}>
            <h2 className={styles.title}>Binance Opciones</h2>
            <p className={styles.subtitle}>
              API key de Binance con el permiso «Enable Options» activado. La usa el módulo de Opciones para el
              trading manual y las estrategias en modo real. El modo sombra y el backtesting no la necesitan.
            </p>
          </div>
          {loaded && <span className={`${styles.status} ${styles[`status_${status.tone}`]}`} role="status">{status.label}</span>}
        </div>

        <div className={styles.grid}>
          <label className={styles.field}>
            Alias
            <input className={styles.input} value={form.alias} onChange={setField('alias')} placeholder="Cuenta principal" autoComplete="off" />
          </label>
          <label className={styles.field}>
            API key
            <input
              className={`${styles.input} ${styles.mono}`}
              value={form.apiKey}
              onChange={setField('apiKey')}
              placeholder={configured ? `${apiKeyMasked || 'Guardada'} (vacío = no cambia)` : 'Pega tu API key'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className={styles.field}>
            Secret
            <input
              className={`${styles.input} ${styles.mono}`}
              type="password"
              value={form.apiSecret}
              onChange={setField('apiSecret')}
              placeholder={configured ? '•••••••• (vacío = no cambia)' : 'Pega tu secret'}
              autoComplete="new-password"
            />
          </label>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.testBtn} onClick={handleTest} disabled={!configured || testing}>
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          {configured && (
            <button type="button" className={styles.deleteBtn} onClick={handleDelete}>
              Eliminar credenciales
            </button>
          )}
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        {checks && (
          <ul aria-label="Resultado de la prueba" className={styles.checks}>
            {checks.length === 0 && <li className={styles.checkDetail}>La prueba no devolvió comprobaciones.</li>}
            {checks.map((c) => (
              <li key={c.id || c.label} className={styles.check}>
                <span className={`${styles.checkDot} ${styles[`dot_${c.status}`] || ''}`} aria-hidden="true" />
                <span className={styles.checkText}>
                  <span className={styles.checkLabel}>
                    {c.label}
                    <span className={styles.srOnly}> ({CHECK_LABEL[c.status] || c.status})</span>
                  </span>
                  {c.detail && <span className={styles.checkDetail}>{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </form>

      <form className={styles.card} onSubmit={handleSaveLimits} aria-label="Límites globales del módulo">
        <h3 className={styles.subTitle}>Límites globales del módulo</h3>
        <p className={styles.subtitle}>Topes que ninguna estrategia en modo real puede superar, se sumen o no.</p>
        <div className={styles.gridNarrow}>
          <label className={styles.field}>
            Margen máximo total (USDT)
            <input className={`${styles.input} ${styles.mono}`} inputMode="decimal" value={limits.maxMarginUsdt} onChange={setLimit('maxMarginUsdt')} />
          </label>
          <label className={styles.field}>
            Pérdida diaria máxima (USDT)
            <input className={`${styles.input} ${styles.mono}`} inputMode="decimal" value={limits.maxDailyLossUsdt} onChange={setLimit('maxDailyLossUsdt')} />
          </label>
          <label className={styles.field}>
            Estrategias reales simultáneas
            <input className={`${styles.input} ${styles.mono}`} inputMode="numeric" value={limits.maxLiveStrategies} onChange={setLimit('maxLiveStrategies')} />
          </label>
        </div>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={limits.notifyTelegram}
            onChange={(e) => setLimits((l) => ({ ...l, notifyTelegram: e.target.checked }))}
          />
          Avisar por Telegram cada orden enviada por una estrategia
        </label>
        {limitsError && <p className={styles.error} role="alert">{limitsError}</p>}
        <div className={styles.actions}>
          <button type="submit" className={styles.saveBtn} disabled={savingLimits}>
            {savingLimits ? 'Guardando…' : 'Guardar límites'}
          </button>
        </div>
      </form>

      <p className={styles.footnote}>
        El secret se guarda cifrado (AES-256-GCM) y nunca vuelve al navegador. Restringe la API key a la IP del
        servidor y no actives retiros.
      </p>

      <ConfirmDialog
        open={!!dialog.open}
        title={dialog.title}
        message={dialog.message}
        confirmLabel={dialog.confirmLabel}
        variant={dialog.variant}
        onConfirm={dialog.onConfirm}
        onCancel={dialog.onCancel}
      />
    </div>
  );
}
