const TARGET_CANDLE_WIDTH_PX = 11;
const MIN_VISIBLE_CANDLES = 30;
const MAX_VISIBLE_CANDLES = 95;
const MIN_RIGHT_OFFSET = 4;
const MAX_RIGHT_OFFSET = 12;
const MAX_CANDLE_SPACING_PX = 18;

export function getInitialChartViewport(containerWidth, candleCount) {
  const width = Number.isFinite(containerWidth) && containerWidth > 0
    ? containerWidth
    : 900;
  const availableCandles = Math.floor(width / TARGET_CANDLE_WIDTH_PX);
  const visibleCandles = Math.min(
    candleCount,
    Math.max(MIN_VISIBLE_CANDLES, Math.min(MAX_VISIBLE_CANDLES, availableCandles)),
  );
  const rightOffset = Math.max(
    MIN_RIGHT_OFFSET,
    Math.min(MAX_RIGHT_OFFSET, Math.round(visibleCandles * 0.1)),
  );
  const barSpacing = Math.min(
    MAX_CANDLE_SPACING_PX,
    Math.max(TARGET_CANDLE_WIDTH_PX, Math.round(width / Math.max(1, visibleCandles))),
  );

  return {
    visibleCandles,
    rightOffset,
    barSpacing,
  };
}
