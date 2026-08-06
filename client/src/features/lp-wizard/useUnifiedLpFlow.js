import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lpOrchestratorApi } from '../../services/api';
import useSmartCreateFlow from '../../pages/UniswapPools/components/smart-create/useSmartCreateFlow';
import { STEP } from '../../pages/UniswapPools/components/smart-create/constants';
import {
  buildDefaultProtection,
  buildProtectionPayload,
  validateProtectionForm,
} from './ProtectionFormFields';

/**
 * Pasos propios del wizard unificado. Los cuatro primeros y los tres
 * terminales los sigue gobernando `useSmartCreateFlow`; PROTECTION es el
 * único paso que este hook inserta, y solo en modo orquestado.
 */
export const UNIFIED_STEP = {
  ...STEP,
  PROTECTION: 'protection',
  OUTCOME: 'outcome',
};

/**
 * Deriva el ancho del rango a partir del rango realmente elegido. Es la
 * regla de la fuente única: el paso Rango manda y la estrategia hereda, así
 * que los rebalanceos futuros replican el ancho que el usuario ya validó.
 */
export function deriveRangeWidthPct(range) {
  const lower = Number(range?.rangeLowerPrice);
  const upper = Number(range?.rangeUpperPrice);
  const center = Number(range?.priceCurrent);
  if (![lower, upper, center].every(Number.isFinite) || center <= 0 || upper <= lower) return null;
  return Math.round(((upper - lower) / 2 / center) * 100 * 100) / 100;
}

/**
 * Espejo de DEFAULT_V4_TICK_SPACING_BY_FEE en
 * server/src/services/smart-pool-creator.service.js. Solo se usa para saber
 * si el pool declara un tickSpacing distinto del que el backend derivaría
 * del fee: si coincide, no hace falta persistirlo.
 */
const DEFAULT_V4_TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const PROTECTION_CONFIG_KEYS = [
  'enabled',
  'leverage',
  'configuredNotionalUsd',
  'bandMode',
  'baseRebalancePriceMovePct',
  'rebalanceIntervalSec',
  'targetHedgeRatio',
  'minRebalanceNotionalUsd',
  'maxSlippageBps',
  'twapMinNotionalUsd',
  'preset',
  'autoTunedFor',
];

export default function useUnifiedLpFlow({
  mode = 'orchestrated',
  wallet,
  defaults,
  onCompleted,
}) {
  const isOrchestrated = mode === 'orchestrated';

  // Red y versión son estado del wizard, no sólo un default heredado: el
  // flujo orquestado tiene que poder crear tanto en v3 como en v4. Cambiarlas
  // reinicia el análisis del pool a través de los efectos de useSmartCreateFlow.
  const [network, setNetwork] = useState(defaults?.network || 'arbitrum');
  const [version, setVersion] = useState(defaults?.version || 'v3');

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [strategy, setStrategy] = useState({ edgeMarginPct: '40', rangeWidthDecoupled: false, rangeWidthPct: '' });
  const initialProtectionTarget = Number(defaults?.totalUsdTarget) || (isOrchestrated ? 0 : 1000);
  const [protection, setProtectionState] = useState(() => buildDefaultProtection(
    initialProtectionTarget,
    null,
    { enabled: isOrchestrated, leverage: isOrchestrated ? '10' : '5' }
  ));

  const [preflight, setPreflight] = useState(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [protectionDone, setProtectionDone] = useState(false);

  const [commitBusy, setCommitBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const intentRef = useRef(null);
  const protectionDirtyRef = useRef(false);
  const walletAddressRef = useRef(null);
  const flowResetRef = useRef(null);

  // El commit corre dentro de `handleExecute` del flujo base, así que la
  // saga se cierra en el mismo gesto en el que el usuario firma.
  const handleFinalized = useCallback(async (finalizeArg) => {
    const innerFinalize = finalizeArg?.finalizeResult || finalizeArg || {};
    const txHashes = finalizeArg?.txHashes || innerFinalize?.txHashes || [];
    const finalizeResult = { ...innerFinalize, txHashes };

    if (!isOrchestrated) {
      setOutcome({ status: 'completed', orchestrator: null, survivingLp: null });
      // Se entrega el finalize completo: quien abre el wizard en standalone
      // puede necesitar vincular la posicion recien creada a algo (el
      // orquestador sin LP la adjunta con attach-lp). Sin esto el LP quedaba
      // on-chain y el caller sin forma de identificarlo.
      onCompleted?.({ status: 'completed', finalizeResult, txHashes });
      return;
    }

    if (!intentRef.current) {
      // Sin intención registrada no hay a qué vincular el LP. Se reporta
      // como compensado con el LP superviviente en vez de descartarlo en
      // silencio, que es lo que dejaba posiciones huérfanas.
      setOutcome({
        status: 'compensated',
        reason: 'Se perdió la referencia a la intención de creación.',
        compensations: [],
        survivingLp: { positionIdentifier: innerFinalize?.positionChanges?.newPositionIdentifier || null, txHashes },
      });
      return;
    }

    setCommitBusy(true);
    try {
      const result = await lpOrchestratorApi.commitIntent({
        operationKey: intentRef.current,
        finalizeResult,
      });
      setOutcome(result);
      onCompleted?.(result);
    } catch (err) {
      setOutcome({
        status: 'compensated',
        reason: err.message || 'El commit de la creación falló.',
        compensations: [],
        needsManualReview: true,
        survivingLp: { positionIdentifier: innerFinalize?.positionChanges?.newPositionIdentifier || null, txHashes },
      });
    } finally {
      setCommitBusy(false);
    }
  }, [isOrchestrated, onCompleted]);

  const flowDefaults = useMemo(
    () => ({ ...defaults, network, version }),
    [defaults, network, version]
  );

  const flow = useSmartCreateFlow({ wallet, defaults: flowDefaults, onFinalized: handleFinalized });
  flowResetRef.current = flow.handleReset;

  const resetProtection = useCallback((targetUsd = 0) => {
    protectionDirtyRef.current = false;
    setProtectionState(buildDefaultProtection(
      Number(targetUsd) || 0,
      null,
      { enabled: isOrchestrated, leverage: isOrchestrated ? '10' : '5' }
    ));
  }, [isOrchestrated]);

  // La sugerencia de notional sigue al objetivo calculado desde la wallet,
  // pero solo hasta que el usuario haya modificado la configuración de
  // cobertura manualmente.
  useEffect(() => {
    if (!isOrchestrated || protectionDirtyRef.current) return;
    const targetUsd = Number(flow.totalUsdTarget);
    if (!Number.isFinite(targetUsd) || targetUsd <= 0) return;
    const suggested = buildDefaultProtection(targetUsd, null, { enabled: true, leverage: '10' });
    setProtectionState((current) => {
      if (
        current.configuredNotionalUsd === suggested.configuredNotionalUsd
        && current.enabled === suggested.enabled
        && current.leverage === suggested.leverage
      ) return current;
      return {
        ...current,
        enabled: true,
        leverage: '10',
        configuredNotionalUsd: suggested.configuredNotionalUsd,
      };
    });
  }, [flow.totalUsdTarget, isOrchestrated]);

  // Cambiar de wallet invalida la intención, el pre-flight y cualquier dato
  // preparado para la dirección anterior. El hook base también limpia sus
  // análisis, fondeo y transacciones mediante handleReset.
  useEffect(() => {
    const nextAddress = String(wallet?.address || '').toLowerCase();
    if (walletAddressRef.current === null) {
      walletAddressRef.current = nextAddress;
      return;
    }
    if (walletAddressRef.current === nextAddress) return;
    walletAddressRef.current = nextAddress;
    setOutcome(null);
    setProtectionDone(false);
    setPreflight(null);
    setCommitBusy(false);
    intentRef.current = null;
    resetProtection(flow.totalUsdTarget);
    flowResetRef.current?.();
  }, [flow.totalUsdTarget, resetProtection, wallet?.address]);

  const handleProtectionChange = useCallback((next) => {
    const changedManually = PROTECTION_CONFIG_KEYS.some((key) => protection?.[key] !== next?.[key]);
    if (changedManually) protectionDirtyRef.current = true;
    setProtectionState(next);
  }, [protection]);

  /**
   * Símbolo de un token del par a partir de su address.
   *
   * El orden importa: `suggestions.token0/token1` los resuelve el backend
   * contra la cadena, así que cubren también las addresses pegadas a mano
   * que no están en el catálogo local. Se busca por address y no por índice
   * porque el backend puede devolverlos en orden de pool (ver
   * `requestedTokenOrderReversed`), que no tiene por qué coincidir con el
   * que eligió el usuario.
   *
   * `tokenOptions` NO sirve aquí: sus items son `{ label, value }` para el
   * <select>, sin `address` ni `symbol`. Buscar ahí devolvía siempre
   * `undefined` y el pre-flight rechazaba el plan con "token0Symbol:
   * expected string, received undefined".
   */
  const symbolForAddress = useCallback((address) => {
    if (!address) return undefined;
    const target = String(address).toLowerCase();
    const fromSuggestions = [flow.suggestions?.token0, flow.suggestions?.token1]
      .find((token) => String(token?.address || '').toLowerCase() === target);
    if (fromSuggestions?.symbol) return fromSuggestions.symbol;
    return flow.tokenList?.find(
      (token) => String(token?.address || '').toLowerCase() === target
    )?.symbol;
  }, [flow.suggestions, flow.tokenList]);

  // Nombre autocompletado desde el pool mientras el usuario no lo toque.
  const suggestedName = useMemo(() => {
    const t0 = symbolForAddress(flow.token0Address);
    const t1 = symbolForAddress(flow.token1Address);
    if (!t0 || !t1) return '';
    return `${t0}/${t1} ${(Number(flow.fee) / 10000).toFixed(2)}% · ${flow.network}`;
  }, [symbolForAddress, flow.token0Address, flow.token1Address, flow.fee, flow.network]);

  const effectiveName = nameTouched ? name : (name || suggestedName);

  const derivedRangeWidthPct = useMemo(
    () => deriveRangeWidthPct({
      rangeLowerPrice: flow.activeRange?.rangeLowerPrice,
      rangeUpperPrice: flow.activeRange?.rangeUpperPrice,
      // `smart-create/suggest` devuelve el precio en `currentPrice`. Se
      // mantienen los nombres anteriores como fallback para no romper
      // respuestas/cache de versiones previas del endpoint.
      priceCurrent: flow.suggestions?.currentPrice
        ?? flow.suggestions?.pool?.priceCurrent
        ?? flow.suggestions?.priceCurrent,
    }),
    [flow.activeRange, flow.suggestions]
  );

  const effectiveRangeWidthPct = strategy.rangeWidthDecoupled
    ? Number(strategy.rangeWidthPct) || null
    : derivedRangeWidthPct;

  // El tickSpacing real del pool lo resuelve el backend al preparar las txs.
  const v4TickSpacingOverride = useMemo(() => {
    if (version !== 'v4') return null;
    const actual = flow.prepareData?.tickSpacing;
    if (actual == null) return null;
    const derived = DEFAULT_V4_TICK_SPACING_BY_FEE[Number(flow.fee)];
    return Number(actual) === derived ? null : Number(actual);
  }, [version, flow.prepareData, flow.fee]);

  /** El plan es lo que viaja al servidor: pre-flight, intención y commit. */
  const buildPlan = useCallback(() => {
    const protectionPayload = isOrchestrated
      ? buildProtectionPayload(protection)
      : { enabled: false };

    return {
      mode,
      name: effectiveName,
      network: flow.network,
      version: flow.version,
      walletAddress: wallet?.address,
      token0Address: flow.token0Address,
      token1Address: flow.token1Address,
      token0Symbol: symbolForAddress(flow.token0Address),
      token1Symbol: symbolForAddress(flow.token1Address),
      feeTier: Number(flow.fee),
      capitalUsd: Number(flow.totalUsdTarget),
      rangeLowerPrice: Number(flow.activeRange?.rangeLowerPrice),
      rangeUpperPrice: Number(flow.activeRange?.rangeUpperPrice),
      priceCurrent: Number(
        flow.suggestions?.currentPrice
        ?? flow.suggestions?.pool?.priceCurrent
        ?? flow.suggestions?.priceCurrent
      ),
      strategy: {
        edgeMarginPct: Number(strategy.edgeMarginPct),
        ...(effectiveRangeWidthPct != null ? { rangeWidthPct: effectiveRangeWidthPct } : {}),
        rangeWidthDecoupled: !!strategy.rangeWidthDecoupled,
        // En v4 el tickSpacing forma parte de la identidad del pool. Solo se
        // manda si difiere del que el backend derivaría del fee tier; si
        // coincide, persistirlo sería ruido.
        ...(v4TickSpacingOverride != null ? { v4TickSpacing: v4TickSpacingOverride } : {}),
      },
      protection: protectionPayload,
    };
  }, [
    mode, isOrchestrated, effectiveName, wallet, protection, strategy,
    effectiveRangeWidthPct, v4TickSpacingOverride, flow.network, flow.version, flow.token0Address,
    flow.token1Address, flow.fee, flow.totalUsdTarget, flow.activeRange,
    flow.suggestions, symbolForAddress,
  ]);

  /** Dry-run de la cobertura. Bloquea el avance a Revisión si no pasa. */
  const runPreflight = useCallback(async () => {
    if (!isOrchestrated) return { ok: true, skipped: true };
    const validationError = validateProtectionForm(protection);
    if (validationError) {
      const failed = { ok: false, checks: [], blockingReason: validationError };
      setPreflight(failed);
      return failed;
    }
    setPreflightBusy(true);
    try {
      const plan = buildPlan();
      const result = await lpOrchestratorApi.preflightProtection({
        token0Symbol: plan.token0Symbol,
        token1Symbol: plan.token1Symbol,
        capitalUsd: plan.capitalUsd,
        protection: plan.protection,
      });
      setPreflight(result);
      return result;
    } catch (err) {
      const failed = { ok: false, checks: [], blockingReason: err.message };
      setPreflight(failed);
      return failed;
    } finally {
      setPreflightBusy(false);
    }
  }, [isOrchestrated, buildPlan, protection]);

  const handleContinueFromProtection = useCallback(async () => {
    const result = await runPreflight();
    if (result?.ok) setProtectionDone(true);
    return result;
  }, [runPreflight]);

  /**
   * Registra la intención y lanza la firma. El orden importa: si el registro
   * falla, no se firma nada.
   */
  const handleSignAndCreate = useCallback(async () => {
    if (isOrchestrated) {
      const protectionError = validateProtectionForm(protection);
      if (protectionError) {
        setPreflight({ ok: false, checks: [], blockingReason: protectionError });
        setProtectionDone(false);
        return;
      }
      const plan = buildPlan();
      if (!Number.isFinite(plan.priceCurrent) || plan.priceCurrent <= 0) {
        setOutcome({
          status: 'blocked',
          reason: 'El análisis del pool no devolvió un precio actual válido. Vuelve a analizar el pool antes de firmar.',
        });
        return;
      }
      try {
        const { operationKey } = await lpOrchestratorApi.createIntent(plan);
        intentRef.current = operationKey;
      } catch (err) {
        setOutcome({
          status: 'blocked',
          reason: `No se pudo registrar la intención: ${err.message}. No se firmó nada.`,
        });
        return;
      }
    }
    await flow.handleExecute();
  }, [isOrchestrated, buildPlan, flow, protection]);

  // El paso PROTECTION se intercala justo antes de REVIEW, sin bifurcar la
  // máquina de estados del flujo base.
  const step = useMemo(() => {
    if (outcome) return UNIFIED_STEP.OUTCOME;
    if (flow.step === STEP.REVIEW && isOrchestrated && !protectionDone) return UNIFIED_STEP.PROTECTION;
    return flow.step;
  }, [outcome, flow.step, isOrchestrated, protectionDone]);

  /**
   * Cambiar de red puede dejar la versión elegida sin soporte. En vez de
   * dejar que el análisis falle con un "pool no encontrado", se ajusta a una
   * versión que la red sí tenga.
   */
  const handleNetworkChange = useCallback((nextNetwork, networkOptions = []) => {
    setNetwork(nextNetwork);
    const supported = (networkOptions.find((n) => n.id === nextNetwork)?.versions || [])
      .filter((v) => v === 'v3' || v === 'v4');
    if (supported.length && !supported.includes(version)) {
      setVersion(supported[0]);
    }
  }, [version]);

  const backFromReview = useCallback(() => {
    if (isOrchestrated) setProtectionDone(false);
    else flow.setStep(STEP.FUNDING);
  }, [isOrchestrated, flow]);

  const backFromProtection = useCallback(() => {
    setPreflight(null);
    flow.setStep(STEP.FUNDING);
  }, [flow]);

  const resetOutcome = useCallback(() => {
    setOutcome(null);
    setProtectionDone(false);
    setPreflight(null);
    intentRef.current = null;
  }, []);

  /**
   * Reintento tras un fallo de firma. Limpia el flujo base y ademas lo propio
   * del modo orquestado: el pre-flight ya validado, la intencion registrada y
   * el paso de cobertura dado por superado.
   *
   * Sin esto el reintento arrancaba con `protectionDone` en true y se saltaba
   * el paso de cobertura entero: se firmaba con un pre-flight que valido OTRO
   * plan. Si en el reintento cambiaba el par, la red o el capital, la
   * cobertura no se revalidaba nunca contra lo que realmente se iba a crear.
   */
  const handleReset = useCallback(() => {
    setOutcome(null);
    setProtectionDone(false);
    setPreflight(null);
    intentRef.current = null;
    resetProtection(flow.totalUsdTarget);
    flow.handleReset();
  }, [flow, resetProtection]);

  return {
    flow,
    mode,
    isOrchestrated,
    step,

    network,
    version,
    setNetwork,
    setVersion,
    handleNetworkChange,

    name: effectiveName,
    setName: (value) => { setNameTouched(true); setName(value); },
    strategy,
    setStrategy,
    protection,
    setProtection: handleProtectionChange,

    derivedRangeWidthPct,
    effectiveRangeWidthPct,

    preflight,
    preflightBusy,
    runPreflight,
    handleContinueFromProtection,
    backFromProtection,
    backFromReview,

    buildPlan,
    handleSignAndCreate,
    commitBusy,
    outcome,
    resetOutcome,
    handleReset,
  };
}
