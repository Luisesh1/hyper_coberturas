import { useCallback, useMemo, useState } from 'react';

const RANGE_RECOMMENDATION_QUOTES = ['USDC', 'USDG'];

/**
 * Recomendación de rango ATR para ETH/WETH + USDC|USDG.
 *
 * Vive fuera de `useUnifiedLpFlow` porque es una regla acotada a un par y a un
 * modo (orquestado): mezclarla con el resto del flujo la volvía invisible
 * dentro de un hook que ya gestiona pool, rango, fondeo, protección y saga.
 */
export default function useEthUsdcRangeRecommendation({
  isOrchestrated,
  flow,
  symbolForAddress,
}) {
  const pairSymbols = useMemo(() => [
    symbolForAddress(flow.token0Address),
    symbolForAddress(flow.token1Address),
  ].map((symbol) => String(symbol || '').toUpperCase()), [flow.token0Address, flow.token1Address, symbolForAddress]);

  const isEthPair = pairSymbols.some((symbol) => symbol === 'ETH' || symbol === 'WETH');
  // El rango ATR también aplica a ETH/USDG (el stable de Robinhood Chain).
  const rangeQuoteSymbol = isEthPair
    ? RANGE_RECOMMENDATION_QUOTES.find((symbol) => pairSymbols.includes(symbol)) || null
    : null;

  // El backend publica esta recomendación sólo para ETH/WETH+USDC|USDG junto con
  // el ATR y el precio usados para calcularla. Se vuelve a verificar el par
  // por símbolo para que una respuesta cacheada o ajena nunca altere otro
  // wizard ni el flujo standalone.
  const ethUsdcRangeRecommendation = useMemo(() => {
    const recommendation = flow.suggestions?.ethUsdcRangeRecommendation;
    if (!isOrchestrated || !rangeQuoteSymbol || !recommendation) return null;
    const halfWidthPct = Number(recommendation.halfWidthPct);
    const widthPct = Number(recommendation.widthPct);
    if (!Number.isFinite(halfWidthPct) || halfWidthPct <= 0 || !Number.isFinite(widthPct) || widthPct <= 0) return null;
    return {
      ...recommendation,
      halfWidthPct,
      widthPct,
      requiresConfirmation: recommendation.requiresConfirmation === true,
      pairLabel: `ETH/${rangeQuoteSymbol}`,
    };
  }, [isOrchestrated, rangeQuoteSymbol, flow.suggestions]);

  const [ethUsdcRangeRecommendationApplied, setEthUsdcRangeRecommendationApplied] = useState(false);
  const [ethUsdcRangeConfirmed, setEthUsdcRangeConfirmedState] = useState(false);
  // El bloqueo sólo se anuncia cuando el usuario ya intentó continuar. Antes
  // de eso la casilla es una opción, no un error, y pintarla en rojo desde que
  // se aplica el rango convertía la recomendación en una advertencia perpetua.
  const [rangeConfirmationBlocked, setRangeConfirmationBlocked] = useState(false);

  const setEthUsdcRangeConfirmed = useCallback((next) => {
    setEthUsdcRangeConfirmedState(next);
    if (next) setRangeConfirmationBlocked(false);
  }, []);

  const applyEthUsdcRangeRecommendation = useCallback(() => {
    if (!ethUsdcRangeRecommendation) return false;
    const currentPrice = Number(flow.suggestions?.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
    const multiplier = ethUsdcRangeRecommendation.halfWidthPct / 100;
    const lower = currentPrice * (1 - multiplier);
    const upper = currentPrice * (1 + multiplier);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) return false;
    // La recomendación tiene que ser un rango explícito, no un preset cuyo
    // índice pueda cambiar con nuevas sugerencias. `custom` conserva además
    // exactamente el ±halfWidth que el usuario revisó.
    flow.setRangeMode('custom');
    flow.setCustomLowerPrice(String(Number(lower.toFixed(8))));
    flow.setCustomUpperPrice(String(Number(upper.toFixed(8))));
    flow.setCustomWeightToken0?.(String(Number(flow.activeRange?.targetWeightToken0Pct ?? 50)));
    setEthUsdcRangeRecommendationApplied(true);
    setEthUsdcRangeConfirmedState(!ethUsdcRangeRecommendation.requiresConfirmation);
    setRangeConfirmationBlocked(false);
    return true;
  }, [ethUsdcRangeRecommendation, flow]);

  const handleContinueFromRange = useCallback(() => {
    if (ethUsdcRangeRecommendationApplied
      && ethUsdcRangeRecommendation?.requiresConfirmation
      && !ethUsdcRangeConfirmed) {
      setRangeConfirmationBlocked(true);
      return { ok: false, requiresConfirmation: true };
    }
    setRangeConfirmationBlocked(false);
    flow.handleContinueToFunding();
    return { ok: true };
  }, [ethUsdcRangeRecommendationApplied, ethUsdcRangeRecommendation, ethUsdcRangeConfirmed, flow]);

  return {
    ethUsdcRangeRecommendation,
    ethUsdcRangeRecommendationApplied,
    ethUsdcRangeConfirmed,
    setEthUsdcRangeConfirmed,
    rangeConfirmationBlocked,
    applyEthUsdcRangeRecommendation,
    handleContinueFromRange,
  };
}
