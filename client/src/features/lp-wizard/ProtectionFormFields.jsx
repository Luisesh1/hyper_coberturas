import { useEffect } from 'react';
import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { formatUsd } from '../../pages/UniswapPools/utils/pool-formatters';
import styles from './ProtectionFormFields.module.css';

// Espeja DEFAULT_MIN_REBALANCE_NOTIONAL_PCT del servidor
// (protected-pool-delta-neutral.helpers.js).
export const DEFAULT_MIN_REBALANCE_NOTIONAL_PCT = 12;

const DELTA_NEUTRAL_PRESETS = [
  { id: 'adaptive', label: 'Adaptive', bandMode: 'adaptive', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, hint: 'Bandas adaptativas por volatilidad. Coste intermedio.' },
  { id: 'balanced', label: 'Balanced', bandMode: 'fixed', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, hint: 'Perfil medio de seguimiento.' },
  { id: 'aggressive', label: 'Aggressive', bandMode: 'fixed', baseRebalancePriceMovePct: 1, rebalanceIntervalSec: 3600, hint: 'Más seguimiento del delta, mayor coste.' },
  { id: 'conservative', label: 'Conservative', bandMode: 'fixed', baseRebalancePriceMovePct: 5, rebalanceIntervalSec: 43200, hint: 'Menos rebalanceo, más drift tolerado.' },
];

const DEFAULT_PROTECTION = Object.freeze({
  enabled: false,
  accountId: '',
  leverage: '10',
  configuredNotionalUsd: '',
  bandMode: 'adaptive',
  baseRebalancePriceMovePct: '3',
  rebalanceIntervalSec: '21600',
  targetHedgeRatio: '1',
  minRebalanceNotionalPct: '12',
  maxSlippageBps: '20',
  twapMinNotionalUsd: '10000',
  preset: 'adaptive',
  policyVersion: 'legacy_zones_v1',
  executionIntent: 'live',
  activationConfirmed: false,
  autoTunedFor: null,
});

/**
 * Auto-ajusta los parámetros de protección delta-neutral al ancho del rango
 * configurado en la estrategia. La motivación detrás de cada regla está en el
 * análisis del comportamiento del motor delta-neutral en
 * `delta-neutral-math.service.js`:
 *
 *  - Rangos estrechos (≤ 2%): la gamma del LP es alta y la delta cambia
 *    rápidamente. Necesitamos rebalancear más seguido (intervalo corto) y
 *    con un trigger porcentual pequeño. Slippage tolerable un poco mayor.
 *  - Rangos medios (2-5%): preset balanceado.
 *  - Rangos amplios (5-10%): preset adaptativo, intervalos largos.
 *  - Rangos muy amplios (>10%): conservador.
 *
 *  - `baseRebalancePriceMovePct ≈ 30% del ancho del rango`, con suelo en 0.5%
 *    y techo en 5%. Esto hace que un movimiento moderado dentro del rango
 *    no dispare un rebalanceo, pero un movimiento sustancial sí.
 *  - `minRebalanceNotionalPct` no depende del ancho: es un % del valor del LP
 *    que el motor resuelve en cada tick, así que ya escala solo con el tamaño
 *    de la posición. Se deja en el default y el usuario puede afinarlo.
 */
export function computeAutoTunedProtection(rangeWidthPct, initialUsd) {
  const rw = Number(rangeWidthPct);
  const initial = Number(initialUsd) || 0;

  if (!Number.isFinite(rw) || rw <= 0) {
    return null;
  }

  // Rebalance trigger: 30% del ancho, suelo 0.5%, techo 5%.
  const baseRebalancePriceMovePct = Math.max(0.5, Math.min(5, rw * 0.3));

  let rebalanceIntervalSec;
  let preset;
  let bandMode;
  let maxSlippageBps;
  if (rw <= 2) {
    rebalanceIntervalSec = 1800;   // 30 min
    preset = 'aggressive';
    bandMode = 'fixed';
    maxSlippageBps = 30;
  } else if (rw <= 5) {
    rebalanceIntervalSec = 3600;   // 1 h
    preset = 'balanced';
    bandMode = 'adaptive';
    maxSlippageBps = 25;
  } else if (rw <= 10) {
    rebalanceIntervalSec = 21600;  // 6 h
    preset = 'adaptive';
    bandMode = 'adaptive';
    maxSlippageBps = 20;
  } else {
    rebalanceIntervalSec = 43200;  // 12 h
    preset = 'conservative';
    bandMode = 'fixed';
    maxSlippageBps = 20;
  }

  // Hedge inicial = mitad del LP (heurística estable + volátil at-the-money).
  const initialHedge = initial / 2;

  return {
    baseRebalancePriceMovePct: Number(baseRebalancePriceMovePct.toFixed(2)),
    rebalanceIntervalSec,
    preset,
    bandMode,
    maxSlippageBps,
    configuredNotionalUsd: Math.round(initialHedge),
    minRebalanceNotionalPct: DEFAULT_MIN_REBALANCE_NOTIONAL_PCT,
  };
}

export function buildDefaultProtection(initialUsd, rangeWidthPct = null, options = {}) {
  const defaults = {
    ...DEFAULT_PROTECTION,
    ...(options.enabled != null ? { enabled: !!options.enabled } : {}),
    ...(options.leverage != null ? { leverage: String(options.leverage) } : {}),
  };
  const tuned = computeAutoTunedProtection(rangeWidthPct, initialUsd);
  if (tuned) {
    return {
      ...defaults,
      configuredNotionalUsd: String(tuned.configuredNotionalUsd || ''),
      bandMode: tuned.bandMode,
      baseRebalancePriceMovePct: String(tuned.baseRebalancePriceMovePct),
      rebalanceIntervalSec: String(tuned.rebalanceIntervalSec),
      minRebalanceNotionalPct: String(tuned.minRebalanceNotionalPct),
      maxSlippageBps: String(tuned.maxSlippageBps),
      preset: tuned.preset,
      autoTunedFor: rangeWidthPct,
    };
  }
  const notional = initialUsd ? String(Math.round(initialUsd / 2)) : '';
  return { ...defaults, configuredNotionalUsd: notional };
}

export default function ProtectionFormFields({
  value,
  onChange,
  accounts = [],
  lpWalletAddress = '',
  defaultLeverage = '5',
  initialUsd = 0,
  rangeWidthPct = null,
}) {
  const v = { ...DEFAULT_PROTECTION, ...(value || {}) };
  const matchingAccount = accounts.find((account) => (
    lpWalletAddress
    && account?.address
    && String(account.address).toLowerCase() === String(lpWalletAddress).toLowerCase()
  ));

  // Solo se autoselecciona una cuenta que sea exactamente la wallet propietaria
  // del LP. Elegir la cuenta default o la primera cuenta podía abrir el hedge
  // en una wallet distinta a la que realmente aporta la liquidez.
  useEffect(() => {
    if (v.enabled && !v.accountId && matchingAccount) {
      onChange({ ...v, accountId: matchingAccount.id });
    }
  }, [matchingAccount, onChange, v]);

  const handleField = (key, val) => {
    onChange({ ...v, [key]: val });
  };

  const handleToggle = (enabled) => {
    if (enabled) {
      onChange({
        ...buildDefaultProtection(initialUsd, rangeWidthPct, { enabled: true, leverage: defaultLeverage }),
        enabled: true,
      });
    } else {
      onChange({ ...DEFAULT_PROTECTION, enabled: false });
    }
  };

  const handleReTune = () => {
    if (!rangeWidthPct) return;
    const tuned = buildDefaultProtection(initialUsd, rangeWidthPct, { enabled: true, leverage: defaultLeverage });
    // Conserva la cuenta y leverage que el usuario ya eligió
    onChange({
      ...tuned,
      enabled: true,
      accountId: v.accountId || tuned.accountId,
      leverage: v.leverage || tuned.leverage,
    });
  };

  const applyPreset = (preset) => {
    onChange({
      ...v,
      preset: preset.id,
      bandMode: preset.bandMode,
      baseRebalancePriceMovePct: String(preset.baseRebalancePriceMovePct),
      rebalanceIntervalSec: String(preset.rebalanceIntervalSec),
      autoTunedFor: null, // se sale del modo auto si elige un preset manual
    });
  };

  const isAutoTuned = v.enabled && v.autoTunedFor != null && Number(v.autoTunedFor) === Number(rangeWidthPct);
  const tunedDrifted = v.enabled && v.autoTunedFor != null && Number(v.autoTunedFor) !== Number(rangeWidthPct);

  return (
    <div className={styles.root}>
      <label className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={!!v.enabled}
          onChange={(e) => handleToggle(e.target.checked)}
        />
        <span>
          <strong>Activar protección delta-neutral</strong>
          <br />
          <span className={styles.muted}>
            El orquestador abrirá un hedge en Hyperliquid que se rebalanceará automáticamente cuando el LP cambie.
          </span>
        </span>
      </label>

      {v.enabled && (isAutoTuned || tunedDrifted) && (
        <div className={`${styles.tuneBanner} ${tunedDrifted ? styles.tuneBannerWarn : ''}`}>
          <div>
            <strong>{tunedDrifted ? '⚠ Auto-tune desactualizado' : '✨ Valores auto-ajustados'}</strong>
            <span className={styles.muted}>
              {tunedDrifted
                ? `El rango actual es ±${rangeWidthPct}% pero los valores fueron ajustados para ±${v.autoTunedFor}%.`
                : `Trigger de rebalance, intervalo, slippage y notional se calcularon a partir de tu rango ±${rangeWidthPct}%. Modifica si quieres.`}
            </span>
          </div>
          {tunedDrifted && (
            <button type="button" className={styles.reTuneBtn} onClick={handleReTune}>
              Re-aplicar
            </button>
          )}
        </div>
      )}

      {v.enabled && (
        <div className={styles.fieldsBlock}>
          <div className={styles.field}>
            <label>Cuenta de Hyperliquid</label>
            <select
              value={v.accountId || ''}
              onChange={(e) => handleField('accountId', Number(e.target.value) || '')}
            >
              <option value="">— selecciona cuenta —</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {formatAccountIdentity(acc)}
                </option>
              ))}
            </select>
            {accounts.length === 0 && (
              <p className={styles.error}>
                No hay cuentas de Hyperliquid. Configura una en Ajustes antes de activar la protección.
              </p>
            )}
            {accounts.length > 0 && !v.accountId && lpWalletAddress && !matchingAccount && (
              <p className={styles.hint}>
                Ninguna cuenta coincide con la wallet del LP. Selecciona una cuenta manualmente.
              </p>
            )}
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label>Leverage</label>
              <input
                type="number"
                min="1"
                max="50"
                step="1"
                value={v.leverage}
                onChange={(e) => handleField('leverage', e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label>Notional USD a hedgear</label>
              <input
                type="number"
                min="1"
                step="1"
                value={v.configuredNotionalUsd}
                onChange={(e) => handleField('configuredNotionalUsd', e.target.value)}
              />
              {initialUsd ? (
                <span className={styles.hint}>
                  Sugerido: {formatUsd(initialUsd / 2)} (mitad del capital LP)
                </span>
              ) : null}
            </div>
          </div>

          <div className={styles.field}>
            <label>Preset de rebalanceo</label>
            <div className={styles.presets}>
              {DELTA_NEUTRAL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`${styles.preset} ${v.preset === preset.id ? styles.presetActive : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <details className={styles.advanced}>
            <summary>Configuración avanzada</summary>
            <div className={styles.field}>
              <label>Política de cobertura</label>
              <select value={v.policyVersion} onChange={(e) => handleField('policyVersion', e.target.value)}>
                <option value="legacy_zones_v1">Legacy zones v1 (operación real)</option>
                <option value="net_profit_v1">Net profit v1 (recomendado ETH/WETH + USDC)</option>
              </select>
              {v.policyVersion === 'net_profit_v1' && (
                <p className={styles.hint}>Empieza en sombra: simula BBO, costes y funding sin mandar órdenes. Para operación real exige confirmación explícita.</p>
              )}
            </div>
            {v.policyVersion === 'net_profit_v1' && (
              <div className={styles.field}>
                <label className={styles.toggleRow}>
                  <input type="checkbox" checked={v.executionIntent === 'live'} onChange={(e) => handleField('executionIntent', e.target.checked ? 'live' : 'shadow')} />
                  <span>Operación real (sustituye la política legacy)</span>
                </label>
                {v.executionIntent === 'live' && (
                  <label className={styles.toggleRow}>
                    <input type="checkbox" checked={!!v.activationConfirmed} onChange={(e) => handleField('activationConfirmed', e.target.checked)} />
                    <span>Confirmo activar órdenes reales de net_profit_v1</span>
                  </label>
                )}
              </div>
            )}
            <div className={styles.row}>
              <div className={styles.field}>
                <label>Band mode</label>
                <select value={v.bandMode} onChange={(e) => handleField('bandMode', e.target.value)}>
                  <option value="adaptive">adaptive</option>
                  <option value="fixed">fixed</option>
                </select>
              </div>
              <div className={styles.field}>
                <label>Rebalance price move (%)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={v.baseRebalancePriceMovePct}
                  onChange={(e) => handleField('baseRebalancePriceMovePct', e.target.value)}
                />
              </div>
            </div>
            <div className={styles.row}>
              <div className={styles.field}>
                <label>Rebalance interval (seg)</label>
                <input
                  type="number"
                  min="60"
                  step="60"
                  value={v.rebalanceIntervalSec}
                  onChange={(e) => handleField('rebalanceIntervalSec', e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label>Target hedge ratio</label>
                <input
                  type="number"
                  min="0.1"
                  max="2"
                  step="0.05"
                  value={v.targetHedgeRatio}
                  onChange={(e) => handleField('targetHedgeRatio', e.target.value)}
                />
              </div>
            </div>
            <div className={styles.row}>
              <div className={styles.field}>
                <label>Min drift para rebalancear (% del LP)</label>
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="any"
                  value={v.minRebalanceNotionalPct}
                  onChange={(e) => handleField('minRebalanceNotionalPct', e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label>Max slippage (bps)</label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={v.maxSlippageBps}
                  onChange={(e) => handleField('maxSlippageBps', e.target.value)}
                />
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/** Convierte el state del form a la shape del payload del backend. */
export function buildProtectionPayload(formValue) {
  if (!formValue || !formValue.enabled) return { enabled: false };
  return {
    enabled: true,
    accountId: Number(formValue.accountId),
    leverage: Number(formValue.leverage),
    configuredNotionalUsd: Number(formValue.configuredNotionalUsd),
    bandMode: formValue.bandMode || 'adaptive',
    baseRebalancePriceMovePct: Number(formValue.baseRebalancePriceMovePct),
    rebalanceIntervalSec: Number(formValue.rebalanceIntervalSec),
    targetHedgeRatio: Number(formValue.targetHedgeRatio),
    minRebalanceNotionalPct: Number(formValue.minRebalanceNotionalPct),
    maxSlippageBps: Number(formValue.maxSlippageBps),
    twapMinNotionalUsd: Number(formValue.twapMinNotionalUsd),
    policyVersion: formValue.policyVersion || 'legacy_zones_v1',
    executionIntent: formValue.executionIntent || 'live',
    ...(formValue.activationConfirmed ? { activationConfirmed: true } : {}),
  };
}

export function validateProtectionForm(formValue) {
  if (!formValue || !formValue.enabled) return null;
  if (!Number.isInteger(Number(formValue.accountId)) || Number(formValue.accountId) < 1) {
    return 'Selecciona una cuenta de Hyperliquid.';
  }
  if (!Number.isFinite(Number(formValue.configuredNotionalUsd)) || Number(formValue.configuredNotionalUsd) <= 0) {
    return 'El notional USD a hedgear debe ser un número positivo.';
  }
  if (!Number.isFinite(Number(formValue.leverage)) || Number(formValue.leverage) < 1) {
    return 'El leverage debe ser >= 1.';
  }
  return null;
}
