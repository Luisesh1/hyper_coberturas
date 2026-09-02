import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Recomendación de rango ATR y política de cobertura para ETH/WETH + USDC.
 *
 * Vive fuera de `useUnifiedLpFlow` porque es una regla acotada a un par y a un
 * modo (orquestado): mezclarla con el resto del flujo la volvía invisible
 * dentro de un hook que ya gestiona pool, rango, fondeo, protección y saga.
 */
export default function useEthUsdcRangeRecommendation({
  isOrchestrated,
  flow,
  symbolForAddress,
  setProtectionState,
  protectionDirtyRef,
}) {
  const isEthUsdcPair = useMemo(() => {
    const symbols = [
      symbolForAddress(flow.token0Address),
      symbolForAddress(flow.token1Address),
    ].map((symbol) => String(symbol || '').toUpperCase());
    return symbols.includes('USDC') && symbols.some((symbol) => symbol === 'ETH' || symbol === 'WETH');
  }, [flow.token0Address, flow.token1Address, symbolForAddress]);

  // La recomendación es un default del wizard, no una regla que sobrescriba
  // una selección del usuario. Al cambiar de par, sólo se restablece mientras
  // la protección siga intacta desde el valor recomendado.
  useEffect(() => {
    if (!isOrchestrated || protectionDirtyRef.current) return;
    // La recomendacion es una POLITICA, no un modo de ejecucion: ya no entra
    // en sombra, porque el formulario dejo de ofrecer sombra y lo que se ve
    // seleccionado es lo que opera. El usuario la ve en el desplegable y la
    // puede cambiar; dejarla recomendada pero corriendo legacy seria otra vez
    // la UI diciendo una cosa y el hedge haciendo otra.
    setProtectionState((current) => {
      if (isEthUsdcPair) {
        if (current.policyVersion === 'net_profit_v2') return current;
        return {
          ...current,
          policyVersion: 'net_profit_v2',
          executionIntent: 'live',
          activationConfirmed: true,
        };
      }
      // Al salir del par solo se deshace la recomendacion, no una eleccion
      // manual: si el usuario ya habia elegido otra, no se toca.
      if (current.policyVersion !== 'net_profit_v2') return current;
      return {
        ...current,
        policyVersion: 'legacy_zones_v1',
        executionIntent: 'live',
        activationConfirmed: true,
      };
    });
  }, [isOrchestrated, isEthUsdcPair, protectionDirtyRef, setProtectionState]);

  // El backend publica esta recomendación sólo para ETH/WETH+USDC junto con
  // el ATR y el precio usados para calcularla. Se vuelve a verificar el par
  // por símbolo para que una respuesta cacheada o ajena nunca altere otro
  // wizard ni el flujo standalone.
  const ethUsdcRangeRecommendation = useMemo(() => {
    const recommendation = flow.suggestions?.ethUsdcRangeRecommendation;
    if (!isOrchestrated || !isEthUsdcPair || !recommendation) return null;
    const halfWidthPct = Number(recommendation.halfWidthPct);
    const widthPct = Number(recommendation.widthPct);
    if (!Number.isFinite(halfWidthPct) || halfWidthPct <= 0 || !Number.isFinite(widthPct) || widthPct <= 0) return null;
    return {
      ...recommendation,
      halfWidthPct,
      widthPct,
      requiresConfirmation: recommendation.requiresConfirmation === true,
    };
  }, [isOrchestrated, isEthUsdcPair, flow.suggestions]);

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
    isEthUsdcPair,
    ethUsdcRangeRecommendation,
    ethUsdcRangeRecommendationApplied,
    ethUsdcRangeConfirmed,
    setEthUsdcRangeConfirmed,
    rangeConfirmationBlocked,
    applyEthUsdcRangeRecommendation,
    handleContinueFromRange,
  };
}
