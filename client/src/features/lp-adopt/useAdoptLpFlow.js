import { useCallback, useMemo, useState } from 'react';
import { lpOrchestratorApi } from '../../services/api';
import {
  buildDefaultProtection,
  buildProtectionPayload,
  validateProtectionForm,
} from '../lp-wizard/ProtectionFormFields';

export const ADOPT_STEP = {
  POSITION: 'position',
  DETAILS: 'details',
  PROTECTION: 'protection',
  REVIEW: 'review',
  DONE: 'done',
};

export const ADOPT_STEPS = [
  { id: ADOPT_STEP.POSITION, label: 'Posición' },
  { id: ADOPT_STEP.DETAILS, label: 'Datos' },
  { id: ADOPT_STEP.PROTECTION, label: 'Cobertura' },
  { id: ADOPT_STEP.REVIEW, label: 'Revisión' },
];

/**
 * Cobertura inicial para una posición: el auto-tune del asistente con el
 * ancho y el capital del LP, el apalancamiento por defecto del activo y, si
 * el hook restringe las políticas, la de borde de rango.
 */
export function buildInitialProtection(candidate) {
  const capital = Number(candidate?.prefill?.initialTotalUsd) || 0;
  const width = Number(candidate?.prefill?.strategyConfig?.rangeWidthPct) || null;
  const leverage = candidate?.protection?.candidate?.defaultLeverage || 10;
  const base = buildDefaultProtection(capital, width, { enabled: true, leverage });
  const allowed = candidate?.protection?.allowedPolicies;
  if (Array.isArray(allowed) && !allowed.includes(base.policyVersion)) {
    return { ...base, policyVersion: allowed.includes('range_exit_v1') ? 'range_exit_v1' : allowed[0] };
  }
  return base;
}

function toNumberOrNull(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Payload de `POST /lp-orchestrators/adopt`. Solo viajan los campos
 * editables; la identidad del pool la relee el servidor de la cadena. La
 * estrategia solo incluye lo que el usuario cambió respecto a la precarga.
 */
export function buildAdoptPayload({ candidate, form, protectionMode, protection }) {
  const position = candidate.position;
  const prefill = candidate.prefill;
  const strategyConfig = {};
  const width = toNumberOrNull(form.rangeWidthPct);
  if (width != null && width !== prefill.strategyConfig.rangeWidthPct) strategyConfig.rangeWidthPct = width;
  const edge = toNumberOrNull(form.edgeMarginPct);
  if (edge != null && edge !== prefill.strategyConfig.edgeMarginPct) strategyConfig.edgeMarginPct = edge;
  const slippage = toNumberOrNull(form.maxSlippageBps);
  if (slippage != null) strategyConfig.maxSlippageBps = Math.round(slippage);

  const capital = toNumberOrNull(form.initialTotalUsd);
  const name = String(form.name || '').trim();

  return {
    network: position.network,
    version: position.version,
    walletAddress: position.walletAddress,
    positionIdentifier: String(position.identifier),
    ...(name ? { name } : {}),
    ...(capital != null ? { initialTotalUsd: capital } : {}),
    ...(Object.keys(strategyConfig).length ? { strategyConfig } : {}),
    protection: protectionMode === 'new'
      ? { mode: 'new', config: buildProtectionPayload(protection) }
      : { mode: protectionMode },
  };
}

export default function useAdoptLpFlow({ defaultNetwork = 'arbitrum', defaultWallet = '', onCompleted }) {
  const [step, setStep] = useState(ADOPT_STEP.POSITION);
  const [network, setNetwork] = useState(defaultNetwork);
  const [walletAddress, setWalletAddress] = useState(defaultWallet);
  const [candidates, setCandidates] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');

  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({});
  const [protectionMode, setProtectionMode] = useState('none');
  const [protection, setProtection] = useState(null);

  const [preflight, setPreflight] = useState(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);

  const scan = useCallback(async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress || '')) {
      setScanError('Introduce una dirección de wallet válida.');
      return;
    }
    setScanBusy(true);
    setScanError('');
    try {
      const data = await lpOrchestratorApi.listAdoptionCandidates({ network, walletAddress });
      setCandidates(data?.candidates || []);
      setWarnings(data?.warnings || []);
    } catch (err) {
      setCandidates(null);
      setScanError(err.message || 'No se pudo escanear la wallet.');
    } finally {
      setScanBusy(false);
    }
  }, [network, walletAddress]);

  const selectCandidate = useCallback((candidate) => {
    if (!candidate?.eligible) return;
    setSelected(candidate);
    setForm({
      name: candidate.prefill.name || '',
      initialTotalUsd: String(candidate.prefill.initialTotalUsd ?? ''),
      rangeWidthPct: String(candidate.prefill.strategyConfig.rangeWidthPct ?? ''),
      edgeMarginPct: String(candidate.prefill.strategyConfig.edgeMarginPct ?? ''),
      maxSlippageBps: '100',
    });
    setProtectionMode(candidate.protection.defaultMode);
    setProtection(buildInitialProtection(candidate));
    setPreflight(null);
    setSubmitError(null);
  }, []);

  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Apagar la cobertura dentro del formulario equivale a elegir «sin cobertura».
  const effectiveMode = protectionMode === 'new' && protection?.enabled === false ? 'none' : protectionMode;

  const detailsError = useMemo(() => {
    if (!selected) return 'Elige una posición.';
    const capital = toNumberOrNull(form.initialTotalUsd);
    if (capital == null || capital <= 0) return 'El capital inicial debe ser positivo.';
    const width = toNumberOrNull(form.rangeWidthPct);
    if (width == null || width <= 0 || width >= 100) return 'El ancho de rango debe estar entre 0 y 100 %.';
    const edge = toNumberOrNull(form.edgeMarginPct);
    if (edge == null || edge < 5 || edge > 49) return 'El margen de borde debe estar entre 5 y 49 %.';
    const slippage = toNumberOrNull(form.maxSlippageBps);
    if (slippage == null || slippage < 1 || slippage > 1000) return 'El slippage máximo debe estar entre 1 y 1000 bps.';
    if (!String(form.name || '').trim()) return 'Ponle un nombre al orquestador.';
    return null;
  }, [selected, form]);

  const runPreflight = useCallback(async () => {
    if (effectiveMode !== 'new') return { ok: true, skipped: true };
    const validationError = validateProtectionForm(protection);
    if (validationError) {
      const failed = { ok: false, checks: [], blockingReason: validationError };
      setPreflight(failed);
      return failed;
    }
    setPreflightBusy(true);
    try {
      const data = await lpOrchestratorApi.preflightProtection({
        token0Symbol: selected.prefill.token0Symbol,
        token1Symbol: selected.prefill.token1Symbol,
        capitalUsd: toNumberOrNull(form.initialTotalUsd) || selected.prefill.initialTotalUsd,
        protection: buildProtectionPayload(protection),
      });
      setPreflight(data);
      return data;
    } catch (err) {
      const failed = { ok: false, checks: [], blockingReason: err.message };
      setPreflight(failed);
      return failed;
    } finally {
      setPreflightBusy(false);
    }
  }, [effectiveMode, protection, selected, form.initialTotalUsd]);

  const continueFromProtection = useCallback(async () => {
    const check = await runPreflight();
    if (check?.ok) setStep(ADOPT_STEP.REVIEW);
  }, [runPreflight]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      const data = await lpOrchestratorApi.adoptExistingLp(buildAdoptPayload({
        candidate: selected, form, protectionMode: effectiveMode, protection,
      }));
      setResult(data);
      setStep(ADOPT_STEP.DONE);
      onCompleted?.(data);
    } catch (err) {
      setSubmitError({
        message: err.message || 'No se pudo adoptar el LP.',
        compensations: err.details?.compensations || [],
      });
      // Un fallo de cobertura se corrige en su paso, con la configuración intacta.
      if (err.code === 'ADOPTION_FAILED' && effectiveMode === 'new') {
        setPreflight({ ok: false, checks: [], blockingReason: err.message });
        setStep(ADOPT_STEP.PROTECTION);
      }
    } finally {
      setSubmitBusy(false);
    }
  }, [selected, form, effectiveMode, protection, onCompleted]);

  return {
    step,
    setStep,
    network,
    setNetwork: (value) => { setNetwork(value); setCandidates(null); setSelected(null); },
    walletAddress,
    setWalletAddress: (value) => { setWalletAddress(value); setCandidates(null); setSelected(null); },
    candidates,
    warnings,
    scan,
    scanBusy,
    scanError,
    selected,
    selectCandidate,
    form,
    setField,
    detailsError,
    protectionMode: effectiveMode,
    setProtectionMode: (mode) => {
      setProtectionMode(mode);
      setPreflight(null);
      if (mode === 'new' && protection?.enabled === false) setProtection(buildInitialProtection(selected));
    },
    protection,
    setProtection: (next) => { setProtection(next); setPreflight(null); },
    preflight,
    preflightBusy,
    runPreflight,
    continueFromProtection,
    submit,
    submitBusy,
    submitError,
    result,
  };
}
