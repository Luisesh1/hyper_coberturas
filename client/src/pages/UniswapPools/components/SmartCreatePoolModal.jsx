import { useEffect, useMemo, useState } from 'react';
import { formatCompactPrice, formatUsd } from '../utils/pool-formatters';
import { formatNumber } from '../../../utils/formatters';
import { getExplorerLink } from '../utils/pool-helpers';
import { uniswapApi } from '../../../services/api';
import styles from './SmartCreatePoolModal.module.css';

const STEP = {
  POOL: 'pool',
  RANGE: 'range',
  FUNDING: 'funding',
  REVIEW: 'review',
  SIGNING: 'signing',
  DONE: 'done',
  ERROR: 'error',
};

const FEE_TIERS = [
  { value: 100, label: '0.01%' },
  { value: 500, label: '0.05%' },
  { value: 3000, label: '0.3%' },
  { value: 10000, label: '1%' },
];

const PRESET_HINTS = {
  conservative: 'Rango amplio siguiendo ATR, con más tolerancia a volatilidad.',
  balanced: 'Balance recomendado entre amplitud del rango y concentración.',
  aggressive: 'Rango más estrecho y concentrado, con mayor sensibilidad al precio.',
};

function PresetCard({ preset, selected, onClick }) {
  return (
    <div
      className={`${styles.presetCard} ${selected ? styles.presetCardSelected : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick();
      }}
    >
      <h4>{preset.label}</h4>
      <div className={styles.presetInfo}>
        <div className={styles.infoRow}>
          <span>Rango</span>
          <strong>${formatCompactPrice(preset.rangeLowerPrice)} — ${formatCompactPrice(preset.rangeUpperPrice)}</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Ancho</span>
          <strong>±{preset.widthPct.toFixed(1)}%</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Token0</span>
          <strong>{preset.targetWeightToken0Pct.toFixed(1)}%</strong>
        </div>
        <div className={styles.infoRow}>
          <span>Token1</span>
          <strong>{(100 - preset.targetWeightToken0Pct).toFixed(1)}%</strong>
        </div>
      </div>
      <p className={styles.hint}>{PRESET_HINTS[preset.preset]}</p>
    </div>
  );
}

function StepPill({ label, active, done }) {
  return (
    <div className={`${styles.stepPill} ${active ? styles.stepPillActive : ''} ${done ? styles.stepPillDone : ''}`}>
      {label}
    </div>
  );
}

function buildSelectionMap(selectedFundingAssets = []) {
  return selectedFundingAssets.reduce((acc, asset) => {
    const previous = acc[asset.assetId];
    const nextAmount = Number(asset.useAmount || 0);
    const previousAmount = Number(previous?.amount || 0);
    const totalAmount = previous ? (previousAmount + nextAmount) : nextAmount;
    acc[asset.assetId] = {
      enabled: true,
      amount: Number.isFinite(totalAmount) ? totalAmount.toFixed(12).replace(/\.?0+$/, '') : String(asset.useAmount || ''),
    };
    return acc;
  }, {});
}

function getSelectedPreset(suggestions, presetKey) {
  return suggestions?.suggestions?.find((item) => item.preset === presetKey) || null;
}

function computeCustomAmounts(suggestions, totalUsdTarget, token0Pct) {
  const token0UsdPrice = Number(suggestions?.token0?.usdPrice || 0);
  const token1UsdPrice = Number(suggestions?.token1?.usdPrice || 0);
  if (!Number.isFinite(token0UsdPrice) || token0UsdPrice <= 0 || !Number.isFinite(token1UsdPrice) || token1UsdPrice <= 0) {
    return { amount0Desired: '0', amount1Desired: '0' };
  }

  const amount0Usd = Number(totalUsdTarget || 0) * (Number(token0Pct || 0) / 100);
  const amount1Usd = Number(totalUsdTarget || 0) * ((100 - Number(token0Pct || 0)) / 100);
  const amount0Desired = amount0Usd > 0 ? amount0Usd / token0UsdPrice : 0;
  const amount1Desired = amount1Usd > 0 ? amount1Usd / token1UsdPrice : 0;

  return {
    amount0Desired: amount0Desired.toFixed(Math.min(6, Number(suggestions?.token0?.decimals || 6))),
    amount1Desired: amount1Desired.toFixed(Math.min(6, Number(suggestions?.token1?.decimals || 6))),
  };
}

function buildOptionalPoolContext(suggestions) {
  const optional = {};
  if (suggestions?.tickSpacing != null) optional.tickSpacing = suggestions.tickSpacing;
  if (suggestions?.hooks) optional.hooks = suggestions.hooks;
  if (suggestions?.poolId) optional.poolId = suggestions.poolId;
  return optional;
}

function deriveFundingIssue(err) {
  if (!err) return null;
  return {
    code: err.code || 'UNKNOWN_FUNDING_ERROR',
    message: err.message || 'No se pudo construir el plan de fondeo.',
    details: err.details || null,
  };
}

function formatFundingIssueTitle(issue) {
  switch (issue?.code) {
    case 'INSUFFICIENT_BALANCE_AFTER_GAS_RESERVE':
      return 'Saldo insuficiente después de reservar gas';
    case 'INSUFFICIENT_SAME_NETWORK_BALANCE':
      return 'Saldo insuficiente en la red seleccionada';
    case 'NO_SUPPORTED_SWAP_ROUTE':
      return 'No hay ruta de swap soportada';
    case 'INSUFFICIENT_DIRECT_OR_SWAP_OUTPUT':
      return 'El capital no alcanza para fondear el LP';
    default:
      return 'No se pudo construir el plan de fondeo';
  }
}

export default function SmartCreatePoolModal({
  wallet,
  sendTransaction,
  waitForTransactionReceipt,
  defaults,
  meta,
  onClose,
  onFinalized,
}) {
  const network = defaults?.network || 'arbitrum';
  const version = defaults?.version || 'v3';
  const [step, setStep] = useState(STEP.POOL);
  const [fee, setFee] = useState(3000);
  const [token0Address, setToken0Address] = useState('');
  const [token1Address, setToken1Address] = useState('');
  const [customToken0, setCustomToken0] = useState('');
  const [customToken1, setCustomToken1] = useState('');
  const [totalUsdTarget, setTotalUsdTarget] = useState('1000');
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

  const networkOptions = Array.isArray(meta?.networks) ? meta.networks : [{ id: 'ethereum', label: 'Ethereum', versions: ['v3'] }];
  const selectedNetwork = networkOptions.find((item) => item.id === network) || networkOptions[0];
  const explorerUrl = selectedNetwork?.explorerUrl || null;

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
  }, [network, version]);

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

      setAvailableAssets(plan.availableFundingAssets || assetsData.assets || []);
      setFundingPlan(plan);
      setFundingIssue(null);
      if (!preserveSelections || !hasFundingEdits) {
        setAssetSelections(buildSelectionMap(plan.selectedFundingAssets || []));
      }
      setStep(STEP.FUNDING);
    } catch (err) {
      setFundingPlan(null);
      setFundingIssue(deriveFundingIssue(err));
      setError('');
      setStep(STEP.FUNDING);
    } finally {
      setIsBusy(false);
      setLoadingMessage('');
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
    setStep(STEP.SIGNING);

    const startIndex = completedTxIndex + 1;
    const hashes = [...txHashes];

    for (let index = startIndex; index < prepareData.txPlan.length; index++) {
      const tx = prepareData.txPlan[index];
      const txLabel = tx?.label || `Transacción ${index + 1}`;
      setCurrentTxIndex(index);
      setLoadingMessage(`Firma "${txLabel}" en tu wallet...`);

      const hash = await sendTransaction(tx);
      if (!hash) {
        setFailedTxLabel(txLabel);
        setError(`No se pudo confirmar el envío de "${txLabel}" porque la wallet no devolvió un hash. Revisa la actividad de tu wallet antes de reintentar.`);
        setStep(STEP.ERROR);
        setLoadingMessage('');
        return;
      }

      hashes.push(hash);
      setTxHashes([...hashes]);
      setLoadingMessage(`Esperando confirmación on-chain de "${txLabel}"...`);

      if (waitForTransactionReceipt) {
        try {
          const receipt = await waitForTransactionReceipt(hash);
          if (!receipt) {
            setFailedTxLabel(txLabel);
            setError(`No se pudo obtener el receipt de "${txLabel}".`);
            setStep(STEP.ERROR);
            setLoadingMessage('');
            return;
          }
          if (Number(receipt.status) !== 1) {
            setFailedTxLabel(txLabel);
            setError(`La transacción "${txLabel}" falló on-chain. Revisa el explorador para más detalles.`);
            setStep(STEP.ERROR);
            setLoadingMessage('');
            return;
          }
        } catch (receiptErr) {
          setFailedTxLabel(txLabel);
          setError(receiptErr.message || `Error esperando confirmación de "${txLabel}".`);
          setStep(STEP.ERROR);
          setLoadingMessage('');
          return;
        }
      }

      setCompletedTxIndex(index);
    }

    setLoadingMessage('Conciliando recibos y finalizando la creación del LP...');
    try {
      await uniswapApi.finalizeCreatePosition({
        network,
        version,
        walletAddress: wallet.address,
        txHashes: hashes,
      });
    } catch (finErr) {
      setError(finErr.message || 'No se pudo finalizar la posición, pero las transacciones fueron exitosas.');
      setStep(STEP.ERROR);
      setLoadingMessage('');
      return;
    }

    setStep(STEP.DONE);
    setLoadingMessage('');
    onFinalized?.();
  }

  function handleRetryFromFailure() {
    setError('');
    setFailedTxLabel('');
    handleExecute();
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

  const reviewFundingAssets = prepareData?.fundingPlan?.selectedFundingAssets || fundingPlan?.selectedFundingAssets || [];
  const reviewSwapPlan = prepareData?.swapPlan || fundingPlan?.swapPlan || [];
  const fundingDiagnostics = fundingPlan || fundingIssue?.details || null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Crear posición LP automáticamente"
      >
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Creación guiada</span>
            <h2 className={styles.title}>Nueva posición LP</h2>
            <p className={styles.desc}>
              Define el pool, ajusta el rango, selecciona el capital fuente y revisa el plan completo antes de firmar.
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className={styles.stepper}>
          <StepPill label="1. Pool" active={step === STEP.POOL} done={[STEP.RANGE, STEP.FUNDING, STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(step)} />
          <StepPill label="2. Rango" active={step === STEP.RANGE} done={[STEP.FUNDING, STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(step)} />
          <StepPill label="3. Fondeo" active={step === STEP.FUNDING} done={[STEP.REVIEW, STEP.SIGNING, STEP.DONE].includes(step)} />
          <StepPill label="4. Review" active={step === STEP.REVIEW || step === STEP.SIGNING || step === STEP.DONE} done={[STEP.SIGNING, STEP.DONE].includes(step)} />
        </div>

        {isBusy && (
          <section className={styles.section}>
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <p>{loadingMessage || 'Trabajando...'}</p>
            </div>
          </section>
        )}

        {!isBusy && step === STEP.POOL && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 1: Selección del pool</span>
            </div>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Red activa</span>
                <strong className={styles.tileValue}>{selectedNetwork?.label || network}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Versión activa</span>
                <strong className={styles.tileValue}>{String(version).toUpperCase()}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Wallet conectada</span>
                <strong className={styles.tileValue}>{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'No conectada'}</strong>
              </div>
            </div>

            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Fee</span>
                <div className={styles.buttonGroup}>
                  {FEE_TIERS.map((tier) => (
                    <button
                      key={tier.value}
                      type="button"
                      className={`${styles.tierBtn} ${fee === tier.value ? styles.tierBtnSelected : ''}`}
                      onClick={() => setFee(tier.value)}
                    >
                      {tier.label}
                    </button>
                  ))}
                </div>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Valor total objetivo (USD)</span>
                <input
                  type="number"
                  value={totalUsdTarget}
                  onChange={(event) => setTotalUsdTarget(event.target.value)}
                  min="1"
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Token 0</span>
                <select className={styles.select} value={token0Address} onChange={(event) => setToken0Address(event.target.value)}>
                  <option value="">— Selecciona token —</option>
                  {tokenOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="O pega dirección custom"
                  value={customToken0}
                  onChange={(event) => setCustomToken0(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Token 1</span>
                <select className={styles.select} value={token1Address} onChange={(event) => setToken1Address(event.target.value)}>
                  <option value="">— Selecciona token —</option>
                  {tokenOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="O pega dirección custom"
                  value={customToken1}
                  onChange={(event) => setCustomToken1(event.target.value)}
                />
              </label>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button type="button" className={styles.primaryBtn} onClick={handleAnalyzePool}>
              Analizar pool y rango
            </button>
          </section>
        )}

        {!isBusy && step === STEP.RANGE && suggestions && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 2: Rango y composición</span>
            </div>

            <div className={styles.balanceRow}>
              <span>Precio actual: {formatNumber(suggestions.currentPrice, 4)}</span>
              <span>ATR 14h: {suggestions.atr14 ? formatNumber(suggestions.atr14, 4) : 'Fallback %'}</span>
              <span>Tick spacing: {suggestions.tickSpacing}</span>
              <span>Valor objetivo: {formatUsd(Number(totalUsdTarget || 0))}</span>
            </div>

            <div className={styles.modeToggle}>
              <button
                type="button"
                className={`${styles.modeBtn} ${rangeMode === 'auto' ? styles.modeBtnActive : ''}`}
                onClick={() => setRangeMode('auto')}
              >
                Auto por ATR
              </button>
              <button
                type="button"
                className={`${styles.modeBtn} ${rangeMode === 'custom' ? styles.modeBtnActive : ''}`}
                onClick={() => setRangeMode('custom')}
              >
                Personalizado
              </button>
            </div>

            {rangeMode === 'auto' && (
              <div className={styles.presetsGrid}>
                {suggestions.suggestions.map((item) => (
                  <PresetCard
                    key={item.preset}
                    preset={item}
                    selected={selectedPreset === item.preset}
                    onClick={() => setSelectedPreset(item.preset)}
                  />
                ))}
              </div>
            )}

            {rangeMode === 'custom' && (
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Precio inferior</span>
                  <input type="number" value={customLowerPrice} onChange={(event) => setCustomLowerPrice(event.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Precio superior</span>
                  <input type="number" value={customUpperPrice} onChange={(event) => setCustomUpperPrice(event.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Balance objetivo Token 0 (%)</span>
                  <input type="number" value={customWeightToken0} min="1" max="99" onChange={(event) => setCustomWeightToken0(event.target.value)} />
                </label>
              </div>
            )}

            {activeRange && (
              <div className={styles.summaryGrid}>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Rango final</span>
                  <strong className={styles.tileValue}>
                    ${formatCompactPrice(activeRange.rangeLowerPrice)} — ${formatCompactPrice(activeRange.rangeUpperPrice)}
                  </strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Token 0</span>
                  <strong className={styles.tileValue}>{formatNumber(activeRange.targetWeightToken0Pct, 1)}%</strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Token 1</span>
                  <strong className={styles.tileValue}>{formatNumber(100 - activeRange.targetWeightToken0Pct, 1)}%</strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Montos estimados</span>
                  <strong className={styles.tileValue}>
                    {formatNumber(Number(activeRange.amount0Desired || 0), 4)} / {formatNumber(Number(activeRange.amount1Desired || 0), 4)}
                  </strong>
                </div>
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={handleReset}>
                ← Volver
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handleContinueToFunding}>
                Continuar a fondeo
              </button>
            </div>
          </section>
        )}

        {!isBusy && step === STEP.FUNDING && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 3: Capital fuente y swaps</span>
            </div>

            <div className={styles.noticeCard}>
              <strong>Fondeo en {selectedNetwork?.label || network}</strong>
              <p>Solo se usan activos disponibles en la red seleccionada. Fondos en otras redes no se consideran automáticamente.</p>
            </div>

            {fundingDiagnostics?.gasReserve && (
              <div className={styles.noticeCard}>
                <strong>Reserva de gas</strong>
                <p>
                  Se reservarán {fundingDiagnostics.gasReserve.reservedAmount} {fundingDiagnostics.gasReserve.symbol} para comisiones.
                </p>
              </div>
            )}

            {fundingDiagnostics && (
              <div className={styles.summaryGrid}>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Red de fondeo</span>
                  <strong className={styles.tileValue}>{selectedNetwork?.label || network}</strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Balance nativo</span>
                  <strong className={styles.tileValue}>
                    {formatNumber(Number(fundingDiagnostics?.gasReserve?.nativeBalance || fundingDiagnostics?.nativeBalance?.balance || 0), 6)} {fundingDiagnostics?.gasReserve?.symbol || fundingDiagnostics?.nativeBalance?.symbol || ''}
                  </strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Capital utilizable</span>
                  <strong className={styles.tileValue}>
                    {formatNumber(Number(fundingDiagnostics?.gasReserve?.usableNative || fundingDiagnostics?.usableNative?.balance || 0), 6)} {fundingDiagnostics?.gasReserve?.symbol || fundingDiagnostics?.usableNative?.symbol || ''}
                  </strong>
                </div>
                <div className={styles.summaryTile}>
                  <span className={styles.tileLabel}>Objetivo / desplegable</span>
                  <strong className={styles.tileValue}>
                    {formatUsd(Number(fundingDiagnostics?.totalUsdTarget || Number(totalUsdTarget || 0)))} / {formatUsd(Number(fundingDiagnostics?.fundingPlan?.estimatedPoolValueUsd || fundingDiagnostics?.deployableUsd || 0))}
                  </strong>
                </div>
              </div>
            )}

            {fundingIssue && (
              <div className={styles.error}>
                <strong>{formatFundingIssueTitle(fundingIssue)}</strong>
                <div>{fundingIssue.message}</div>
                {fundingIssue.details?.missingUsd > 0 && (
                  <div>Falta estimada: {formatUsd(fundingIssue.details.missingUsd)}</div>
                )}
                <div className={styles.inlineActions}>
                  <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                    Cambiar red en la página
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.POOL)}>
                    Reducir monto objetivo
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={() => refreshFundingPlan({ preserveSelections: true })}>
                    Reintentar
                  </button>
                </div>
              </div>
            )}

            <div className={styles.inlineActions}>
              <input
                type="text"
                placeholder="Importar token por dirección"
                value={importTokenAddress}
                onChange={(event) => setImportTokenAddress(event.target.value)}
              />
              <button type="button" className={styles.secondaryBtn} onClick={handleAddFundingImport}>
                Añadir token
              </button>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Slippage máximo (bps)</span>
              <input
                type="number"
                value={maxSlippageBps}
                min="1"
                max="200"
                onChange={(event) => {
                  setMaxSlippageBps(event.target.value);
                  setHasFundingEdits(true);
                }}
              />
            </label>

            <div className={styles.assetList}>
              {availableAssets.map((asset) => {
                const selection = assetSelections[asset.id] || { enabled: false, amount: '' };
                return (
                  <div key={asset.id} className={styles.assetRow}>
                    <label className={styles.assetCheckbox}>
                      <input
                        type="checkbox"
                        checked={selection.enabled}
                        onChange={(event) => {
                          setAssetSelections((prev) => ({
                            ...prev,
                            [asset.id]: {
                              enabled: event.target.checked,
                              amount: prev[asset.id]?.amount || asset.usableBalance || asset.balance,
                            },
                          }));
                          setHasFundingEdits(true);
                        }}
                      />
                      <span>{asset.symbol}</span>
                    </label>
                    <span className={styles.assetMeta}>Balance: {formatNumber(Number(asset.balance || 0), 6)}</span>
                    <span className={styles.assetMeta}>Usable: {formatNumber(Number(asset.usableBalance || asset.balance || 0), 6)}</span>
                    <input
                      type="number"
                      value={selection.amount || ''}
                      disabled={!selection.enabled}
                      onChange={(event) => {
                        setAssetSelections((prev) => ({
                          ...prev,
                          [asset.id]: {
                            enabled: prev[asset.id]?.enabled ?? true,
                            amount: event.target.value,
                          },
                        }));
                        setHasFundingEdits(true);
                      }}
                    />
                  </div>
                );
              })}
            </div>

            {fundingPlan && (
              <>
                <div className={styles.summaryGrid}>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Pool estimado</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.estimatedPoolValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Directo</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.directValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Por swaps</span>
                    <strong className={styles.tileValue}>{formatUsd(fundingPlan.fundingPlan?.swapValueUsd || 0)}</strong>
                  </div>
                  <div className={styles.summaryTile}>
                    <span className={styles.tileLabel}>Swaps</span>
                    <strong className={styles.tileValue}>{fundingPlan.swapPlan?.length || 0}</strong>
                  </div>
                </div>

                <div className={styles.txList}>
                  <h4>Swaps planeados</h4>
                  {(fundingPlan.swapPlan || []).length === 0 && (
                    <div className={styles.txItem}>
                      <span className={styles.txLabel}>No hacen falta swaps; la wallet ya puede fondear el LP directamente.</span>
                    </div>
                  )}
                  {(fundingPlan.swapPlan || []).map((swap, index) => (
                    <div key={`${swap.sourceAssetId}-${index}`} className={styles.txItem}>
                      <span className={styles.txLabel}>
                        {swap.requiresWrapNative ? `Wrap ${swap.sourceSymbol} y ` : ''}
                        swap {swap.amountIn} {swap.tokenIn.symbol} → {swap.estimatedAmountOut} {swap.tokenOut.symbol} (fee {FEE_TIERS.find((tier) => tier.value === swap.fee)?.label || swap.fee})
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.RANGE)}>
                ← Ajustar rango
              </button>
              <button type="button" className={styles.secondaryBtn} onClick={() => refreshFundingPlan({ preserveSelections: true })}>
                Recalcular plan
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handlePrepareReview} disabled={!fundingPlan}>
                Revisar y preparar firma
              </button>
            </div>
          </section>
        )}

        {!isBusy && step === STEP.REVIEW && prepareData && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>Paso 4: Review y firma</span>
            </div>

            <div className={styles.summaryGrid}>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Red / versión</span>
                <strong className={styles.tileValue}>{selectedNetwork?.label || network} · {String(version).toUpperCase()}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Wallet</span>
                <strong className={styles.tileValue}>{wallet?.address ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : 'No conectada'}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Pool</span>
                <strong className={styles.tileValue}>{prepareData.quoteSummary?.token0?.symbol} / {prepareData.quoteSummary?.token1?.symbol}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Fee</span>
                <strong className={styles.tileValue}>{FEE_TIERS.find((item) => item.value === fee)?.label}</strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Rango</span>
                <strong className={styles.tileValue}>
                  ${formatCompactPrice(activeRange?.rangeLowerPrice)} — ${formatCompactPrice(activeRange?.rangeUpperPrice)}
                </strong>
              </div>
              <div className={styles.summaryTile}>
                <span className={styles.tileLabel}>Gas reservado</span>
                <strong className={styles.tileValue}>
                  {prepareData.fundingPlan?.gasReserve?.reservedAmount} {prepareData.fundingPlan?.gasReserve?.symbol}
                </strong>
              </div>
            </div>

            <div className={styles.txList}>
              <h4>Activos fuente seleccionados</h4>
              {reviewFundingAssets.map((asset) => (
                <div key={`${asset.assetId}-${asset.fundingRole}`} className={styles.txItem}>
                  <span className={styles.txLabel}>
                    {asset.useAmount} {asset.symbol} · {asset.fundingRole === 'swap_source' ? 'Swap source' : 'Aporte directo'}
                  </span>
                </div>
              ))}
            </div>

            <div className={styles.txList}>
              <h4>Transacciones a firmar ({prepareData.txPlan?.length || 0})</h4>
              {prepareData.txPlan?.map((tx, index) => (
                <div key={`${tx.kind}-${index}`} className={styles.txItem}>
                  <span className={styles.txLabel}>{tx.label || `Tx ${index + 1}`}</span>
                </div>
              ))}
            </div>

            {reviewSwapPlan?.length > 0 && (
              <div className={styles.txList}>
                <h4>Swaps</h4>
                {reviewSwapPlan.map((swap, index) => (
                  <div key={`${swap.sourceAssetId}-${index}`} className={styles.txItem}>
                    <span className={styles.txLabel}>
                      {swap.amountIn} {swap.tokenIn.symbol} → min {swap.amountOutMinimum} {swap.tokenOut.symbol}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(prepareData.warnings || []).length > 0 && (
              <div className={styles.noticeCard}>
                <strong>Advertencias</strong>
                {(prepareData.warnings || []).map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.buttonGroup}>
              <button type="button" className={styles.secondaryBtn} onClick={() => setStep(STEP.FUNDING)}>
                ← Volver a fondeo
              </button>
              <button type="button" className={styles.primaryBtn} onClick={handleExecute}>
                Firmar con wallet
              </button>
            </div>
          </section>
        )}

        {step === STEP.SIGNING && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.kicker}>
                Transacción {Math.min(currentTxIndex + 1, prepareData?.txPlan?.length || 0)} de {prepareData?.txPlan?.length || 0}
              </span>
            </div>
            <div className={styles.txProgressList}>
              {(prepareData?.txPlan || []).map((tx, index) => {
                const label = tx?.label || `Transacción ${index + 1}`;
                const isDone = index <= completedTxIndex;
                const isActive = index === currentTxIndex && !isDone;
                const hash = txHashes[index] || null;
                const txLink = hash && explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                return (
                  <div
                    key={`${tx?.kind}-${index}`}
                    className={`${styles.txStepItem} ${isDone ? styles.txStepDone : ''} ${isActive ? styles.txStepActive : ''} ${!isDone && !isActive ? styles.txStepPending : ''}`}
                  >
                    <span className={styles.txStepIcon}>
                      {isDone ? '✓' : isActive ? '' : '○'}
                    </span>
                    <span className={styles.txStepLabel}>{label}</span>
                    {isDone && hash && (
                      <span className={styles.txStepHash}>
                        {txLink
                          ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                          : <span>{hash.slice(0, 10)}…</span>
                        }
                      </span>
                    )}
                    {isActive && <span className={styles.txStepSpinner} />}
                  </div>
                );
              })}
            </div>
            <div className={styles.loading}>
              <p>{loadingMessage || 'Firma cada transacción en tu wallet...'}</p>
            </div>
          </section>
        )}

        {step === STEP.DONE && (
          <section className={styles.section}>
            <div className={styles.success}>
              <div className={styles.checkmark}>✓</div>
              <p>Posición LP creada correctamente.</p>
            </div>
            {txHashes.length > 0 && (
              <div className={styles.txList}>
                <h4>Transacciones confirmadas ({txHashes.length})</h4>
                {txHashes.map((hash, index) => {
                  const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
                  const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                  return (
                    <div key={hash} className={styles.txItem}>
                      <span className={styles.txLabel}>
                        {label}
                        {' — '}
                        {txLink
                          ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 14)}…{hash.slice(-6)}</a>
                          : <span className={styles.hint}>{hash.slice(0, 14)}…{hash.slice(-6)}</span>
                        }
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={styles.buttonGroup}>
              <button type="button" className={styles.primaryBtn} onClick={onClose}>
                Cerrar
              </button>
            </div>
          </section>
        )}

        {step === STEP.ERROR && (
          <section className={styles.section}>
            <div className={styles.errorBox}>
              <p>{error || 'Ocurrió un error en el wizard de creación LP.'}</p>

              {completedTxIndex >= 0 && txHashes.length > 0 && (
                <div className={styles.txList}>
                  <h4>Transacciones completadas exitosamente</h4>
                  {txHashes.map((hash, index) => {
                    const label = prepareData?.txPlan?.[index]?.label || `Transacción ${index + 1}`;
                    const txLink = explorerUrl ? getExplorerLink(explorerUrl, 'tx', hash) : null;
                    return (
                      <div key={hash} className={styles.txItem}>
                        <span className={styles.txLabel}>
                          {label}
                          {' — '}
                          {txLink
                            ? <a href={txLink} target="_blank" rel="noopener noreferrer" className={styles.txLink}>{hash.slice(0, 10)}…</a>
                            : <span>{hash.slice(0, 10)}…</span>
                          }
                        </span>
                      </div>
                    );
                  })}
                  <p className={styles.hint}>
                    Las aprobaciones ya firmadas siguen vigentes. Solo se reintentará desde la transacción que falló.
                  </p>
                </div>
              )}

              {failedTxLabel && (
                <p className={styles.hint}>Transacción fallida: {failedTxLabel}</p>
              )}

              <div className={styles.buttonGroup}>
                {completedTxIndex >= 0 && prepareData?.txPlan?.length > 0 && (
                  <button type="button" className={styles.primaryBtn} onClick={handleRetryFromFailure}>
                    Reintentar desde aquí
                  </button>
                )}
                <button type="button" className={styles.secondaryBtn} onClick={handleReset}>
                  Empezar de nuevo
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                  Cerrar
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
