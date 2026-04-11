import { useEffect, useMemo, useRef, useState } from 'react';
import { uniswapApi } from '../../../../services/api';
import { useWalletExecution, WALLET_EXECUTION_STATE } from '../../../../hooks/useWalletExecution';
import { STEP } from './constants';
import {
  buildSelectionMap,
  getSelectedPreset,
  computeCustomAmounts,
  buildOptionalPoolContext,
  deriveFundingIssue,
} from './helpers';

/**
 * Custom hook que encapsula todo el estado y la lógica del wizard
 * SmartCreatePoolModal. La UI sólo consume los valores y callbacks
 * que retorna este hook.
 */
export default function useSmartCreateFlow({ wallet, defaults, onFinalized }) {
  const network = defaults?.network || 'arbitrum';
  const version = defaults?.version || 'v3';

  // ── state ─────────────────────────────────────────────────────────
  const [step, setStep] = useState(STEP.POOL);
  const [fee, setFee] = useState(() => Number(defaults?.fee) || 3000);
  const [token0Address, setToken0Address] = useState(() => defaults?.token0Address || '');
  const [token1Address, setToken1Address] = useState(() => defaults?.token1Address || '');
  const [customToken0, setCustomToken0] = useState('');
  const [customToken1, setCustomToken1] = useState('');
  const [totalUsdTarget, setTotalUsdTarget] = useState(() => (
    defaults?.totalUsdTarget != null ? String(defaults.totalUsdTarget) : '1000'
  ));
  const [rangeMode, setRangeMode] = useState('auto');
  const [selectedPreset, setSelectedPreset] = useState('balanced');
  const [customLowerPrice, setCustomLowerPrice] = useState('');
  const [customUpperPrice, setCustomUpperPrice] = useState('');
  const [customWeightToken0, setCustomWeightToken0] = useState('50');
  const [maxSlippageBps, setMaxSlippageBps] = useState('50');
  const [importTokenAddress, setImportTokenAddress] = useState('');
  const [importedFundingTokens, setImportedFundingTokens] = useState([]);
  const [assetSelections, setAssetSelections] = useState({});
  const [hasFundingEdits, setHasFundingEdits] = useState(false);
  const [tokenList, setTokenList] = useState([]);
  const [suggestions, setSuggestions] = useState(null);
  const [availableAssets, setAvailableAssets] = useState([]);
  const [fundingPlan, setFundingPlan] = useState(null);
  const [fundingIssue, setFundingIssue] = useState(null);
  const [prepareData, setPrepareData] = useState(null);
  const [txHashes, setTxHashes] = useState([]);
  const [completedTxIndex, setCompletedTxIndex] = useState(-1);
  const [currentTxIndex, setCurrentTxIndex] = useState(-1);
  const [failedTxLabel, setFailedTxLabel] = useState('');
  const [error, setError] = useState('');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const execution = useWalletExecution();
  const autoAnalyzedRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── effects ───────────────────────────────────────────────────────

  useEffect(() => {
    async function loadTokenList() {
      try {
        const data = await uniswapApi.getSmartCreateTokenList(network);
        setTokenList(Array.isArray(data) ? data : []);
      } catch (err) {
        setTokenList([]);
        setError(err.message || 'No se pudo cargar la lista de tokens.');
      }
    }
    loadTokenList().catch(() => {});
  }, [network]);

  useEffect(() => {
    setStep(STEP.POOL);
    setSuggestions(null);
    setAvailableAssets([]);
    setFundingPlan(null);
    setFundingIssue(null);
    setPrepareData(null);
    setTxHashes([]);
    setAssetSelections({});
    setImportedFundingTokens([]);
    setImportTokenAddress('');
    setError('');
    setHasFundingEdits(false);
    autoAnalyzedRef.current = false;
  }, [network, version]);

  useEffect(() => {
    if (!execution.normalizedError?.message) return;
    setError(execution.normalizedError.message);
  }, [execution.normalizedError]);

  useEffect(() => {
    setTxHashes(execution.txHashes);
    setCompletedTxIndex(execution.progress.completed - 1);
    setCurrentTxIndex(execution.currentTx?.index ?? -1);

    if (execution.state === WALLET_EXECUTION_STATE.PREFLIGHT) {
      setLoadingMessage('Validando transacciones antes de abrir la wallet...');
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.AWAITING_WALLET) {
      setLoadingMessage(execution.currentTx?.label
        ? `Firma "${execution.currentTx.label}" en tu wallet...`
        : 'Firma la transacción en tu wallet...');
      setStep(STEP.SIGNING);
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.BROADCAST_SUBMITTED || execution.state === WALLET_EXECUTION_STATE.NETWORK_CONFIRMING) {
      setLoadingMessage(execution.currentTx?.label
        ? `Esperando confirmación on-chain de "${execution.currentTx.label}"...`
        : 'Esperando confirmación on-chain...');
      setStep(STEP.SIGNING);
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.FINALIZE_PENDING) {
      setLoadingMessage('Conciliando recibos y finalizando la creación del LP...');
      setStep(STEP.SIGNING);
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.DONE) {
      setLoadingMessage('');
      setStep(STEP.DONE);
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.NEEDS_RECONCILE || execution.state === WALLET_EXECUTION_STATE.FAILED) {
      setLoadingMessage('');
      setStep(STEP.ERROR);
      return;
    }
    if (execution.state === WALLET_EXECUTION_STATE.IDLE) {
      setLoadingMessage('');
    }
  }, [execution.currentTx, execution.progress.completed, execution.state, execution.txHashes]);

  const handleAnalyzePoolRef = useRef(null);

  useEffect(() => {
    if (autoAnalyzedRef.current) return;
    if (!wallet?.address) return;
    if (step !== STEP.POOL) return;
    if (!defaults?.token0Address || !defaults?.token1Address) return;
    if (!defaults?.fee || !defaults?.totalUsdTarget) return;
    autoAnalyzedRef.current = true;
    handleAnalyzePoolRef.current?.().catch(() => {});
  }, [wallet?.address, defaults?.token0Address, defaults?.token1Address, defaults?.fee, defaults?.totalUsdTarget, step]);

  // ── derived / memos ───────────────────────────────────────────────

  const tokenOptions = useMemo(() => (
    tokenList.map((token) => ({
      label: `${token.symbol} (${token.address.slice(0, 6)}…${token.address.slice(-4)})`,
      value: token.address,
    }))
  ), [tokenList]);

  const activeRange = useMemo(() => {
    if (!suggestions) return null;
    if (rangeMode === 'auto') return getSelectedPreset(suggestions, selectedPreset);
    const customAmounts = computeCustomAmounts(suggestions, totalUsdTarget, customWeightToken0);
    return {
      preset: 'custom',
      label: 'Personalizado',
      rangeLowerPrice: Number(customLowerPrice || 0),
      rangeUpperPrice: Number(customUpperPrice || 0),
      widthPct: suggestions.currentPrice > 0
        ? (((Number(customUpperPrice || 0) - Number(customLowerPrice || 0)) / Number(suggestions.currentPrice)) * 100)
        : 0,
      targetWeightToken0Pct: Number(customWeightToken0 || 0),
      amount0Desired: customAmounts.amount0Desired,
      amount1Desired: customAmounts.amount1Desired,
    };
  }, [customLowerPrice, customUpperPrice, customWeightToken0, rangeMode, selectedPreset, suggestions, totalUsdTarget]);

  const normalizedFundingSelections = useMemo(() => (
    Object.entries(assetSelections)
      .filter(([, value]) => value?.enabled)
      .map(([assetId, value]) => ({
        assetId,
        amount: value.amount,
        enabled: true,
      }))
  ), [assetSelections]);

  // ── handlers ──────────────────────────────────────────────────────

  handleAnalyzePoolRef.current = handleAnalyzePool;
  async function handleAnalyzePool() {
    if (!wallet?.address) {
      setError('Conecta tu wallet antes de crear una posición LP.');
      return;
    }

    const resolvedToken0 = customToken0.trim() || token0Address;
    const resolvedToken1 = customToken1.trim() || token1Address;
    if (!resolvedToken0 || !resolvedToken1) {
      setError('Selecciona o importa ambos tokens del par.');
      return;
    }
    if (resolvedToken0.toLowerCase() === resolvedToken1.toLowerCase()) {
      setError('Los tokens del par deben ser distintos.');
      return;
    }
    if (!Number(totalUsdTarget) || Number(totalUsdTarget) <= 0) {
      setError('Define un valor total objetivo mayor que cero.');
      return;
    }

    setError('');
    setIsBusy(true);
    setLoadingMessage('Analizando el pool y calculando presets de rango con ATR...');
    try {
      const data = await uniswapApi.smartCreateSuggest({
        network,
        version,
        walletAddress: wallet.address,
        token0Address: resolvedToken0,
        token1Address: resolvedToken1,
        fee,
        totalUsdTarget: Number(totalUsdTarget),
      });
      setToken0Address(resolvedToken0);
      setToken1Address(resolvedToken1);
      setSuggestions(data);
      setFundingIssue(null);
      setSelectedPreset(data?.suggestions?.[1]?.preset || data?.suggestions?.[0]?.preset || 'balanced');
      setCustomLowerPrice(String(data?.suggestions?.[1]?.rangeLowerPrice || data?.suggestions?.[0]?.rangeLowerPrice || ''));
      setCustomUpperPrice(String(data?.suggestions?.[1]?.rangeUpperPrice || data?.suggestions?.[0]?.rangeUpperPrice || ''));
      setCustomWeightToken0(String(data?.suggestions?.[1]?.targetWeightToken0Pct || data?.suggestions?.[0]?.targetWeightToken0Pct || '50'));
      setStep(STEP.RANGE);
    } catch (err) {
      setError(err.message || 'No se pudo analizar el pool.');
      setStep(STEP.ERROR);
    } finally {
      setIsBusy(false);
      setLoadingMessage('');
    }
  }

  async function refreshFundingPlan({ preserveSelections = false } = {}) {
    if (!wallet?.address || !activeRange) return;
    setError('');
    setIsBusy(true);
    setLoadingMessage('Construyendo plan de fondeo y swaps...');

    try {
      const assetsData = await uniswapApi.getSmartCreateAssets({
        network,
        walletAddress: wallet.address,
        importTokenAddresses: importedFundingTokens,
      });
      if (!isMountedRef.current) return;
      setAvailableAssets(assetsData.assets || []);
      const plan = await uniswapApi.smartCreateFundingPlan({
        network,
        version,
        walletAddress: wallet.address,
        token0Address,
        token1Address,
        fee,
        totalUsdTarget: Number(totalUsdTarget),
        targetWeightToken0Pct: Number(activeRange.targetWeightToken0Pct),
        rangeLowerPrice: Number(activeRange.rangeLowerPrice),
        rangeUpperPrice: Number(activeRange.rangeUpperPrice),
        maxSlippageBps: Number(maxSlippageBps || 50),
        importTokenAddresses: importedFundingTokens,
        fundingSelections: preserveSelections ? normalizedFundingSelections : undefined,
        ...buildOptionalPoolContext(suggestions),
      });
      if (!isMountedRef.current) return;

      setAvailableAssets(plan.availableFundingAssets || assetsData.assets || []);
      setFundingPlan(plan);
      setFundingIssue(null);
      if (!preserveSelections || !hasFundingEdits) {
        setAssetSelections(buildSelectionMap(plan.selectedFundingAssets || []));
      }
      setStep(STEP.FUNDING);
    } catch (err) {
      if (!isMountedRef.current) return;
      setFundingPlan(null);
      setFundingIssue(deriveFundingIssue(err));
      setError('');
      setStep(STEP.FUNDING);
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false);
        setLoadingMessage('');
      }
    }
  }

  async function handleContinueToFunding() {
    if (!activeRange?.rangeLowerPrice || !activeRange?.rangeUpperPrice) {
      setError('Define un rango válido antes de continuar.');
      return;
    }
    if (!Number(activeRange.targetWeightToken0Pct) || Number(activeRange.targetWeightToken0Pct) <= 0 || Number(activeRange.targetWeightToken0Pct) >= 100) {
      setError('El balance objetivo entre activos debe estar entre 0% y 100%.');
      return;
    }
    setHasFundingEdits(false);
    await refreshFundingPlan({ preserveSelections: false });
  }

  async function handleApplyRecommended() {
    const recommended = fundingPlan?.recommendedFundingSelection;
    if (!Array.isArray(recommended) || recommended.length === 0) return;
    const recommendedMap = {};
    for (const item of recommended) {
      const asset = (availableAssets || []).find((a) => a.id === item.assetId);
      if (!asset) continue;
      recommendedMap[item.assetId] = {
        enabled: true,
        amount: asset.usableBalance || asset.balance,
      };
    }
    setAssetSelections(recommendedMap);
    setHasFundingEdits(true);
    await refreshFundingPlan({ preserveSelections: true });
  }

  async function handlePrepareReview() {
    if (!fundingPlan) {
      setError('Genera primero un plan de fondeo.');
      return;
    }
    setError('');
    setIsBusy(true);
    setLoadingMessage('Validando el plan final y preparando transacciones...');
    try {
      const data = await uniswapApi.prepareCreatePosition({
        network,
        version,
        walletAddress: wallet.address,
        token0Address,
        token1Address,
        fee,
        totalUsdTarget: Number(totalUsdTarget),
        targetWeightToken0Pct: Number(activeRange.targetWeightToken0Pct),
        rangeLowerPrice: Number(activeRange.rangeLowerPrice),
        rangeUpperPrice: Number(activeRange.rangeUpperPrice),
        maxSlippageBps: Number(maxSlippageBps || 50),
        importTokenAddresses: importedFundingTokens,
        fundingSelections: normalizedFundingSelections,
        ...buildOptionalPoolContext(suggestions),
      });
      setPrepareData(data);
      setFundingIssue(null);
      setStep(STEP.REVIEW);
    } catch (err) {
      setFundingIssue(deriveFundingIssue(err));
      setError('');
      setStep(STEP.FUNDING);
    } finally {
      setIsBusy(false);
      setLoadingMessage('');
    }
  }

  async function handleExecute() {
    if (!prepareData?.txPlan?.length) {
      setError('No hay transacciones preparadas para firmar.');
      return;
    }
    if (prepareData.expiresAt && Date.now() > prepareData.expiresAt) {
      setError('El plan expiró, los precios pueden haber cambiado. Vuelve a preparar las transacciones.');
      setStep(STEP.REVIEW);
      return;
    }
    setError('');
    setFailedTxLabel('');

    const finalizeResult = await execution.runPlan({
      action: 'create-position',
      chainId: prepareData.txPlan[0]?.chainId || null,
      txPlan: prepareData.txPlan,
      finalizePayload: {
        network,
        version,
        walletAddress: wallet.address,
      },
      finalizeKind: 'position_action',
    });

    if (finalizeResult?.status === 'done') {
      onFinalized?.({ txHashes: finalizeResult.txHashes || execution.txHashes, finalizeResult });
    } else if (!finalizeResult && execution.currentTx?.label) {
      setFailedTxLabel(execution.currentTx.label);
    }
  }

  function handleReset() {
    setStep(STEP.POOL);
    setSuggestions(null);
    setAvailableAssets([]);
    setFundingPlan(null);
    setFundingIssue(null);
    setPrepareData(null);
    setTxHashes([]);
    setCompletedTxIndex(-1);
    setCurrentTxIndex(-1);
    setFailedTxLabel('');
    setAssetSelections({});
    setImportedFundingTokens([]);
    setImportTokenAddress('');
    setError('');
    setHasFundingEdits(false);
    execution.reset();
  }

  function handleAddFundingImport() {
    const normalized = importTokenAddress.trim();
    if (!normalized) return;
    if (!importedFundingTokens.includes(normalized)) {
      setImportedFundingTokens((prev) => [...prev, normalized]);
    }
    setImportTokenAddress('');
    setHasFundingEdits(true);
  }

  // ── derived values for the UI ─────────────────────────────────────

  const reviewFundingAssets = prepareData?.fundingPlan?.selectedFundingAssets || fundingPlan?.selectedFundingAssets || [];
  const reviewSwapPlan = prepareData?.swapPlan || fundingPlan?.swapPlan || [];
  const fundingDiagnostics = fundingPlan || fundingIssue?.details || null;

  return {
    // core wizard state
    network,
    version,
    step,
    setStep,
    fee,
    setFee,
    token0Address,
    setToken0Address,
    token1Address,
    setToken1Address,
    customToken0,
    setCustomToken0,
    customToken1,
    setCustomToken1,
    totalUsdTarget,
    setTotalUsdTarget,
    rangeMode,
    setRangeMode,
    selectedPreset,
    setSelectedPreset,
    customLowerPrice,
    setCustomLowerPrice,
    customUpperPrice,
    setCustomUpperPrice,
    customWeightToken0,
    setCustomWeightToken0,
    maxSlippageBps,
    setMaxSlippageBps,
    importTokenAddress,
    setImportTokenAddress,
    importedFundingTokens,
    assetSelections,
    setAssetSelections,
    setHasFundingEdits,
    tokenList,
    suggestions,
    availableAssets,
    fundingPlan,
    fundingIssue,
    prepareData,
    txHashes,
    completedTxIndex,
    currentTxIndex,
    failedTxLabel,
    error,
    loadingMessage,
    isBusy,

    // derived
    tokenOptions,
    activeRange,
    reviewFundingAssets,
    reviewSwapPlan,
    fundingDiagnostics,

    // handlers
    handleAnalyzePool,
    handleContinueToFunding,
    handleApplyRecommended,
    handlePrepareReview,
    handleExecute,
    handleReset,
    handleAddFundingImport,
    refreshFundingPlan,
  };
}
