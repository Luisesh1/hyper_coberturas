import { useEffect } from 'react';
import { formatAccountIdentity } from '../../utils/hyperliquidAccounts';
import { formatUsd } from '../../pages/UniswapPools/utils/pool-formatters';
import { computeDeltaNotionalUsd, computeHedgeConsequence, computeVolatileFraction } from './hedgeNotional';
import styles from './ProtectionFormFields.module.css';

// Espeja DEFAULT_MIN_REBALANCE_NOTIONAL_PCT del servidor
// (protected-pool-delta-neutral.helpers.js).
export const DEFAULT_MIN_REBALANCE_NOTIONAL_PCT = 12;
// Espeja DEFAULT_CENTER_DEAD_ZONE_PCT del servidor: % del ancho TOTAL del
// rango, centrado, donde la cobertura no rebalancea. 0 la desactiva.
export const DEFAULT_CENTER_DEAD_ZONE_PCT = 40;
export const MAX_CENTER_DEAD_ZONE_PCT = 90;

const DELTA_NEUTRAL_PRESETS = [
  { id: 'adaptive', label: 'Adaptive', bandMode: 'adaptive', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, hint: 'Bandas adaptativas por volatilidad. Coste intermedio.' },
  { id: 'balanced', label: 'Balanced', bandMode: 'fixed', baseRebalancePriceMovePct: 3, rebalanceIntervalSec: 21600, hint: 'Perfil medio de seguimiento.' },
  { id: 'aggressive', label: 'Aggressive', bandMode: 'fixed', baseRebalancePriceMovePct: 1, rebalanceIntervalSec: 3600, hint: 'Más seguimiento del delta, mayor coste.' },
  { id: 'conservative', label: 'Conservative', bandMode: 'fixed', baseRebalancePriceMovePct: 5, rebalanceIntervalSec: 43200, hint: 'Menos rebalanceo, más drift tolerado.' },
];

// Sombra no es "la política apagada", es un modo con resultado propio: la
// cobertura la sigue haciendo el motor legacy y net profit calcula en paralelo
// lo que habría hecho. Por eso se elige entre dos opciones con nombre y no con
// una casilla "operación real" cuyo estado apagado no se explica solo.
// Politicas que tienen modo sombra. Legacy no lo tiene (es la que ejecuta por
// defecto), asi que elegirla vuelve el intent a `live`. Mantener esta lista
// junto al selector: si una politica nueva entra al <select> sin entrar aca,
// se ofreceria directamente en operacion real.
const SHADOW_CAPABLE_POLICIES = ['net_profit_v1', 'net_profit_v2', 'range_exit_v1'];

const EXECUTION_INTENTS = [
  {
    id: 'shadow',
    label: 'Sombra',
    hint: 'Cubre con el motor legacy y mide la política nueva en paralelo (BBO, costes y funding). No manda órdenes propias.',
  },
  {
    id: 'live',
    label: 'Operación real',
    hint: 'La política nueva decide y ejecuta. Sustituye por completo a las zonas legacy.',
  },
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
  centerDeadZonePct: '40',
  maxSlippageBps: '20',
  twapMinNotionalUsd: '10000',
  preset: 'adaptive',
  policyVersion: 'legacy_zones_v1',
  executionIntent: 'live',
  activationConfirmed: false,
  autoTunedFor: null,
  // El notional se dimensiona solo desde el delta del rango salvo que el
  // usuario lo desactive. `capital/2` sólo acierta con el precio centrado.
  notionalAuto: true,
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
    // Es una fraccion del rango, no un valor absoluto: ya escala con el ancho
    // que elija el usuario, asi que no se auto-ajusta.
    centerDeadZonePct: DEFAULT_CENTER_DEAD_ZONE_PCT,
  };
}

/**
 * Resuelve el notional que propone el modo automático, junto con la frase que
 * lo justifica. Devuelve `null` cuando ni siquiera hay capital que repartir.
 *
 * Sin precio ni bordes del rango cae a `capital/2`, que es la heurística vieja:
 * correcta sólo con el precio centrado, pero es lo mejor disponible mientras el
 * paso de rango no haya resuelto todavía sus precios.
 */
export function resolveAutoNotional({ capitalUsd, currentPrice, rangeLowerPrice, rangeUpperPrice }) {
  const capital = Number(capitalUsd);
  if (!Number.isFinite(capital) || capital <= 0) return null;

  const fromDelta = computeDeltaNotionalUsd({
    capitalUsd: capital, currentPrice, rangeLowerPrice, rangeUpperPrice,
  });

  if (fromDelta == null) {
    return {
      notionalUsd: capital / 2,
      exact: false,
      explanation: 'Sin precio del pool todavía: se usa la mitad del capital. Se recalcula al fijar el rango.',
    };
  }

  const fraction = computeVolatileFraction({ currentPrice, rangeLowerPrice, rangeUpperPrice });
  const pct = Math.round(fraction * 100);
  let explanation;
  if (fraction >= 0.99) {
    explanation = 'El precio está por debajo del rango: el LP es todo token volátil.';
  } else if (fraction <= 0.01) {
    explanation = 'El precio está por encima del rango: no queda exposición volátil que cubrir.';
  } else if (fraction > 0.6) {
    explanation = `El precio está cerca del borde inferior, así que ${pct}% de tu LP es token volátil.`;
  } else if (fraction < 0.4) {
    explanation = `El precio está cerca del borde superior, así que sólo ${pct}% de tu LP es token volátil.`;
  } else {
    explanation = `Con el precio centrado en el rango, ${pct}% de tu LP es token volátil.`;
  }

  return { notionalUsd: fromDelta, exact: true, pct, explanation };
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
      centerDeadZonePct: String(tuned.centerDeadZonePct),
      maxSlippageBps: String(tuned.maxSlippageBps),
      preset: tuned.preset,
      autoTunedFor: rangeWidthPct,
    };
  }
  const notional = initialUsd ? String(Math.round(initialUsd / 2)) : '';
  return { ...defaults, configuredNotionalUsd: notional };
}

/**
 * Posicion del precio dentro del rango, 0 (borde inferior) a 1 (superior).
 * Espeja `rangePositionFraction` del servidor
 * (protected-pool-delta-neutral.helpers.js): se mide en espacio logaritmico
 * porque un rango de Uniswap son ticks, y su centro real es el medio
 * geometrico. Con la mitad aritmetica el marcador mentiria justo en el borde
 * de la zona, que es donde el usuario mira.
 */
export function rangePositionFraction(currentPrice, rangeLowerPrice, rangeUpperPrice) {
  const lower = Math.min(Number(rangeLowerPrice), Number(rangeUpperPrice));
  const upper = Math.max(Number(rangeLowerPrice), Number(rangeUpperPrice));
  const price = Number(currentPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) return null;
  if (!Number.isFinite(price) || price < lower || price > upper) return null;
  return Math.log(price / lower) / Math.log(upper / lower);
}

/**
 * El corredor de cobertura: el rango completo, con el tramo central congelado
 * y el precio actual encima. El porcentaje solo no dice DONDE deja de operar
 * la cobertura, que es la unica pregunta que este ajuste tiene que contestar.
 */
function CenterDeadZoneTrack({ pct, currentPrice, rangeLowerPrice, rangeUpperPrice }) {
  const parsed = Number(pct);
  const width = Number.isFinite(parsed) ? Math.min(MAX_CENTER_DEAD_ZONE_PCT, Math.max(0, parsed)) : 0;
  const fraction = rangePositionFraction(currentPrice, rangeLowerPrice, rangeUpperPrice);
  const frozenNow = fraction != null && width > 0 && Math.abs(fraction - 0.5) <= width / 200;
  const decimals = (width / 2) % 1 === 0 ? 0 : 1;

  return (
    <div className={styles.zoneTrack}>
      <div className={styles.zoneBar}>
        {width > 0 && (
          <div
            className={styles.zoneFrozen}
            style={{ left: `${50 - width / 2}%`, width: `${width}%` }}
          />
        )}
        {fraction != null && (
          <div
            className={`${styles.zoneMarker} ${frozenNow ? styles.zoneMarkerFrozen : ''}`}
            style={{ left: `${fraction * 100}%` }}
          />
        )}
      </div>
      <div className={styles.zoneLegend}>
        <span>Borde inf.</span>
        <span className={styles.zoneLegendMid}>
          {width > 0
            ? `Congelado ${(50 - width / 2).toFixed(decimals)}%–${(50 + width / 2).toFixed(decimals)}%`
            : 'Rebalancea en todo el rango'}
        </span>
        <span>Borde sup.</span>
      </div>
      {fraction != null && (
        <p className={`${styles.zoneNow} ${frozenNow ? styles.zoneNowFrozen : styles.zoneNowLive}`}>
          {frozenNow
            ? 'Con el precio de ahora la cobertura no rebalancea.'
            : 'Con el precio de ahora la cobertura rebalancea.'}
        </p>
      )}
    </div>
  );
}

export default function ProtectionFormFields({
  value,
  onChange,
  accounts = [],
  lpWalletAddress = '',
  defaultLeverage = '5',
  initialUsd = 0,
  rangeWidthPct = null,
  currentPrice = null,
  rangeLowerPrice = null,
  rangeUpperPrice = null,
}) {
  const raw = value || {};
  // Las protecciones persistidas antes de que existiera el modo auto no traen
  // la clave: heredar el default `true` pisaría en silencio el notional que su
  // dueño fijó a mano. Sólo se asume auto cuando no hay nada que respetar.
  const inferredAuto = raw.notionalAuto != null
    ? !!raw.notionalAuto
    : !(raw.configuredNotionalUsd > 0 || String(raw.configuredNotionalUsd || '').trim() !== '');
  const v = { ...DEFAULT_PROTECTION, ...raw, notionalAuto: inferredAuto };
  const auto = resolveAutoNotional({
    capitalUsd: initialUsd, currentPrice, rangeLowerPrice, rangeUpperPrice,
  });
  // Con auto activo el número mostrado manda sobre lo que haya en el state:
  // así cambiar el rango en un paso anterior se refleja sin tocar nada.
  const effectiveNotionalUsd = v.notionalAuto && auto ? auto.notionalUsd : Number(v.configuredNotionalUsd);
  const hedgeConsequence = computeHedgeConsequence({
    notionalUsd: effectiveNotionalUsd, leverage: v.leverage,
  });
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

  // El payload se construye desde `configuredNotionalUsd`, así que el modo auto
  // tiene que escribir su resultado en el state y no sólo pintarlo. Sin esto un
  // cambio de rango dejaba la UI mostrando un número y el backend recibiendo otro.
  useEffect(() => {
    if (!v.enabled || !v.notionalAuto || !auto) return;
    const next = auto.notionalUsd.toFixed(2);
    if (v.configuredNotionalUsd !== next) {
      onChange({ ...v, configuredNotionalUsd: next });
    }
  }, [auto, onChange, v]);

  const handleField = (key, val) => {
    onChange({ ...v, [key]: val });
  };

  // Desmarcar deja el input listo para editar sobre el valor calculado, no vacío.
  const handleNotionalAuto = (notionalAuto) => {
    onChange({
      ...v,
      notionalAuto,
      ...(auto ? { configuredNotionalUsd: auto.notionalUsd.toFixed(2) } : {}),
    });
  };

  // La política de cobertura no es un parámetro de tuning: la elige el par
  // (el wizard recomienda net_profit_v2 en sombra para ETH/USDC) o el usuario
  // a mano. Reconstruir los defaults por apagar y encender la protección o por
  // re-aplicar el auto-tune la devolvía a legacy en silencio, y como el cambio
  // marca la protección como "sucia", la recomendación ya no volvía nunca.
  const policySelection = {
    policyVersion: v.policyVersion,
    executionIntent: v.executionIntent,
    activationConfirmed: v.activationConfirmed,
  };

  const handleToggle = (enabled) => {
    if (enabled) {
      onChange({
        ...buildDefaultProtection(initialUsd, rangeWidthPct, { enabled: true, leverage: defaultLeverage }),
        ...policySelection,
        enabled: true,
      });
    } else {
      onChange({ ...DEFAULT_PROTECTION, ...policySelection, enabled: false });
    }
  };

  const handleReTune = () => {
    if (!rangeWidthPct) return;
    const tuned = buildDefaultProtection(initialUsd, rangeWidthPct, { enabled: true, leverage: defaultLeverage });
    // Conserva la cuenta y leverage que el usuario ya eligió
    onChange({
      ...tuned,
      ...policySelection,
      enabled: true,
      accountId: v.accountId || tuned.accountId,
      leverage: v.leverage || tuned.leverage,
    });
  };

  // Cambiar de política nunca deja una combinación a medias: las políticas con
  // modo sombra entran siempre en sombra y legacy no lo tiene, así que vuelve
  // a `live`.
  const handlePolicyChange = (policyVersion) => {
    onChange({
      ...v,
      policyVersion,
      executionIntent: SHADOW_CAPABLE_POLICIES.includes(policyVersion) ? 'shadow' : 'live',
      activationConfirmed: false,
    });
  };

  const handleIntentChange = (executionIntent) => {
    onChange({
      ...v,
      executionIntent,
      activationConfirmed: executionIntent === 'live' ? v.activationConfirmed : false,
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

  const isNetProfit = ['net_profit_v1', 'net_profit_v2'].includes(v.policyVersion);
  const isRangeExit = v.policyVersion === 'range_exit_v1';
  const isLiveNetProfit = isNetProfit && v.executionIntent === 'live';
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
              <label htmlFor="notional-auto">Notional a cubrir</label>
              <label className={styles.autoRow} htmlFor="notional-auto">
                <input
                  id="notional-auto"
                  type="checkbox"
                  checked={!!v.notionalAuto}
                  onChange={(e) => handleNotionalAuto(e.target.checked)}
                  aria-label="Calcular el notional automáticamente"
                />
                <span>Automático</span>
              </label>
              {v.notionalAuto ? (
                <span className={styles.autoValue}>{formatUsd(effectiveNotionalUsd)}</span>
              ) : (
                <input
                  type="number"
                  min="1"
                  step="1"
                  aria-label="Notional USD a hedgear"
                  value={v.configuredNotionalUsd}
                  onChange={(e) => handleField('configuredNotionalUsd', e.target.value)}
                />
              )}
            </div>
          </div>

          {v.notionalAuto && auto && (
            <span className={styles.hint}>{auto.explanation}</span>
          )}

          {/* El margen requerido y la distancia a liquidación salían sólo en el
              pre-flight, en otra tarjeta y tras pulsar un botón. Aquí convierten
              dos números abstractos en una decisión informada mientras se teclean. */}
          {hedgeConsequence && (
            <div className={styles.consequence}>
              <span>margen <strong>{formatUsd(hedgeConsequence.requiredMarginUsd)}</strong></span>
              <span>liquidación <strong>−{hedgeConsequence.liquidationMovePct}%</strong></span>
            </div>
          )}

          {/* La política decide qué motor cubre la posición, así que no puede
              vivir dentro de "Configuración avanzada": el wizard la cambia solo
              para ETH/USDC y el usuario tiene que ver ese cambio sin abrir nada. */}
          <div className={`${styles.policyCard} ${isNetProfit ? styles.policyCardNew : ''}`}>
            <div className={styles.field}>
              <label>Política de cobertura</label>
              <select value={v.policyVersion} onChange={(e) => handlePolicyChange(e.target.value)}>
                <option value="legacy_zones_v1">Zonas legacy — motor en producción</option>
                <option value="net_profit_v1">Net profit — bandas por coste neto</option>
                <option value="net_profit_v2">Net profit V2 — ajuste parcial y límites de rotación</option>
                <option value="range_exit_v1">Borde de rango — cubre al abrir y sólo reajusta al salir/entrar</option>
              </select>
            </div>

            {!isNetProfit && !isRangeExit && (
              <p className={styles.hint}>
                Cubre por zonas respecto al borde del rango: en el centro deja ~40% del delta
                descubierto a propósito, y los umbrales de zona no escalan con el ancho del rango.
              </p>
            )}

            {isRangeExit && (
              <p className={styles.hint}>
                Cubre el 100% del delta al abrir y no vuelve a tocar el hedge mientras el precio
                siga dentro del rango: sólo reajusta al salir y al volver a entrar, con el disparo
                corrido lo justo para pagar comisiones. Gasta mucho menos en ejecución, y a cambio
                acepta quedar descubierta dentro del rango — gana si el precio revierte y pierde
                si se va en tendencia. Aún no tiene un tramo tendencial medido:
                <strong> déjala en sombra hasta tenerlo</strong>.
              </p>
            )}

            {isNetProfit && (
              <>
                {/* Segmented control, no una rejilla de tarjetas: compartir la
                    clase `.presets` con el preset de rebalanceo hacía que dos
                    decisiones opuestas — "¿opera con dinero real?" y "¿cada
                    cuánto rebalanceo?" — tuvieran la misma forma. El color
                    carga el significado: cian mide, ámbar arriesga. */}
                <div className={styles.segmented} role="group" aria-label="Modo de ejecución">
                  {EXECUTION_INTENTS.map((intent) => (
                    <button
                      key={intent.id}
                      type="button"
                      aria-pressed={v.executionIntent === intent.id}
                      className={[
                        styles.segment,
                        v.executionIntent === intent.id ? styles.segmentActive : '',
                        v.executionIntent === intent.id && intent.id === 'live' ? styles.segmentLive : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleIntentChange(intent.id)}
                    >
                      {intent.label}
                    </button>
                  ))}
                </div>
                <p className={styles.hint}>
                  {EXECUTION_INTENTS.find((i) => i.id === v.executionIntent)?.hint}
                </p>

                {isLiveNetProfit && (
                  <label className={`${styles.toggleRow} ${styles.riskGate}`}>
                    <input
                      type="checkbox"
                      checked={!!v.activationConfirmed}
                      onChange={(e) => handleField('activationConfirmed', e.target.checked)}
                    />
                    <span>
                      <strong>Confirmo activar órdenes reales con net profit</strong>
                      <br />
                      <span className={styles.muted}>
                        El servidor rechaza la creación sin esta confirmación, y además exige que el
                        feature gate de net profit esté habilitado.
                      </span>
                    </span>
                  </label>
                )}

                {isLiveNetProfit && !v.activationConfirmed && (
                  <p className={styles.error}>Marca la confirmación o vuelve a modo sombra para continuar.</p>
                )}
              </>
            )}
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
            {isLiveNetProfit && (
              <p className={styles.hint}>
                Con net profit en operación real el motor ignora <strong>target hedge ratio</strong> (fija 1,
                cobertura del 100% del delta) y recorta el slippage a un máximo de 15 bps.
              </p>
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
            <div className={styles.zoneField}>
              <div className={styles.zoneHead}>
                <label htmlFor="centerDeadZonePct">Zona central sin rebalanceo</label>
                <div className={styles.zoneInput}>
                  <input
                    id="centerDeadZonePct"
                    type="number"
                    min="0"
                    max={MAX_CENTER_DEAD_ZONE_PCT}
                    step="5"
                    value={v.centerDeadZonePct}
                    onChange={(e) => handleField('centerDeadZonePct', e.target.value)}
                  />
                  <span>% del rango</span>
                </div>
              </div>
              <CenterDeadZoneTrack
                pct={v.centerDeadZonePct}
                currentPrice={currentPrice}
                rangeLowerPrice={rangeLowerPrice}
                rangeUpperPrice={rangeUpperPrice}
              />
              <small className={styles.hint}>{describeCenterDeadZone(v.centerDeadZonePct)}</small>
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
    centerDeadZonePct: Number(formValue.centerDeadZonePct),
    maxSlippageBps: Number(formValue.maxSlippageBps),
    twapMinNotionalUsd: Number(formValue.twapMinNotionalUsd),
    policyVersion: formValue.policyVersion || 'legacy_zones_v1',
    executionIntent: formValue.executionIntent || 'live',
    ...(formValue.activationConfirmed ? { activationConfirmed: true } : {}),
  };
}

/**
 * Traduce el % de zona muerta a los bordes que el usuario ve en el rango: con
 * 40 la cobertura se congela entre el 30% y el 70%. Sin esto el numero solo no
 * dice donde deja de operar.
 */
export function describeCenterDeadZone(pct) {
  const parsed = Number(pct);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'Sin zona muerta: la cobertura sigue al delta en todo el rango.';
  }
  return 'Ahorra las comisiones de re-cubrir contra ruido. Los cierres, los cambios de liquidez '
    + 'y los rebalanceos forzados se ejecutan igual.';
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
  // Espeja la validación del servidor (uniswap-protection.service.js). Sin
  // esto el wizard dejaba avanzar hasta el pre-flight para morir allí con un
  // error de validación que ya se podía anticipar en el formulario.
  const deadZone = Number(formValue.centerDeadZonePct);
  if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone > MAX_CENTER_DEAD_ZONE_PCT) {
    return `La zona central sin rebalanceo debe estar entre 0 y ${MAX_CENTER_DEAD_ZONE_PCT}%.`;
  }
  if (['net_profit_v1', 'net_profit_v2'].includes(formValue.policyVersion)
    && formValue.executionIntent === 'live'
    && formValue.activationConfirmed !== true) {
    return 'Confirma la operación real de net profit o vuelve a modo sombra.';
  }
  return null;
}
