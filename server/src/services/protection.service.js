function formatSize(size, szDecimals) {
  const numericSize = parseFloat(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return (0).toFixed(szDecimals);
  }

  const [integerPart, fractionalPart = ''] = numericSize
    .toFixed(szDecimals + 8)
    .split('.');

  return `${integerPart}.${fractionalPart.slice(0, szDecimals).padEnd(szDecimals, '0')}`;
}

function formatPrice(price) {
  if (!price || price <= 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = 5 - d;
  const magnitude = Math.pow(10, power);
  const rounded = Math.round(price * magnitude) / magnitude;
  return power > 0 ? rounded.toFixed(power) : rounded.toString();
}

async function placePositionProtection({
  hl,
  asset,
  side,
  size,
  slPrice,
  tpPrice,
}) {
  const assetName = asset.toUpperCase();
  const requestedSize = size != null ? Math.abs(parseFloat(size)) : null;

  if (!slPrice && !tpPrice) {
    throw new Error('Debes indicar al menos slPrice o tpPrice');
  }

  const [assetMeta, pos] = await Promise.all([
    hl.getAssetMeta(assetName),
    hl.getPosition(assetName),
  ]);

  if (!pos || parseFloat(pos.szi) === 0) {
    throw new Error(`No existe posicion abierta en ${assetName}`);
  }

  const positionSize = Math.abs(parseFloat(pos.szi));
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    throw new Error(`Tamaño de posicion invalido en ${assetName}`);
  }

  const positionSide = parseFloat(pos.szi) > 0 ? 'long' : 'short';
  if (side && side !== positionSide) {
    throw new Error(
      `La posicion abierta en ${assetName} es ${positionSide}, no ${side}`
    );
  }

  const sizeToProtect = requestedSize
    ? Math.min(requestedSize, positionSize)
    : positionSize;

  if (!Number.isFinite(sizeToProtect) || sizeToProtect <= 0) {
    throw new Error(`Tamaño a proteger invalido en ${assetName}`);
  }

  const wireSize = formatSize(sizeToProtect, assetMeta.szDecimals);
  const isLong = positionSide === 'long';
  const results = {
    asset: assetName,
    positionSide,
    positionSize,
    protectedSize: sizeToProtect,
  };

  if (slPrice) {
    results.slOid = await hl.placeSL({
      assetIndex: assetMeta.index,
      isBuy: !isLong,
      size: wireSize,
      triggerPx: formatPrice(parseFloat(slPrice)),
      isMarket: true,
    });
  }

  if (tpPrice) {
    results.tpOid = await hl.placeTP({
      assetIndex: assetMeta.index,
      isBuy: !isLong,
      size: wireSize,
      triggerPx: formatPrice(parseFloat(tpPrice)),
    });
  }

  return results;
}

module.exports = {
  formatPrice,
  formatSize,
  placePositionProtection,
};
