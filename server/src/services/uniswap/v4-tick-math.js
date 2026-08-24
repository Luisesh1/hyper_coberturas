/**
 * Puente exacto (BigInt) de TickMath de Uniswap V4. No usa `Number`: al
 * inicializar una pool, redondear un sqrtPrice con floats puede mover el tick
 * activo y cambiar los montos requeridos por el mint inicial.
 */
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;
const Q128 = 1n << 128n;
const Q32_MASK = (1n << 32n) - 1n;

const MULTIPLIERS = [
  '0xfffcb933bd6fad37aa2d162d1a594001', '0xfff97272373d413259a46990580e213a',
  '0xfff2e50f5f656932ef12357cf3c7fdcc', '0xffe5caca7e10e4e61c3624eaa0941cd0',
  '0xffcb9843d60f6159c9db58835c926644', '0xff973b41fa98c081472e6896dfb254c0',
  '0xff2ea16466c96a3843ec78b326b52861', '0xfe5dee046a99a2a811c461f1969c3053',
  '0xfcbe86c7900a88aedcffc83b479aa3a4', '0xf987a7253ac413176f2b074cf7815e54',
  '0xf3392b0822b70005940c7a398e4b70f3', '0xe7159475a2c29b7443b29c7fa6e889d9',
  '0xd097f3bdfd2022b8845ad8f792aa5825', '0xa9f746462d870fdf8a65dc1f90e061e5',
  '0x70d869a156d2a1b890bb3df62baf32f7', '0x31be135f97d08fd981231505542fcfa6',
  '0x9aa508b5b7a84e1c677de54f3e99bc9', '0x5d6af8dedb81196699c329225ee604',
  '0x2216e584f5fa1ea926041bedfe98', '0x48a170391f7dc42444e8fa2',
].map(BigInt);

function getSqrtPriceX96AtTick(tick) {
  const normalizedTick = Number(tick);
  if (!Number.isInteger(normalizedTick) || normalizedTick < MIN_TICK || normalizedTick > MAX_TICK) {
    throw new RangeError(`Tick V4 fuera de rango: ${tick}`);
  }
  const absoluteTick = Math.abs(normalizedTick);
  let ratio = (absoluteTick & 1) ? MULTIPLIERS[0] : Q128;
  for (let bit = 1; bit < MULTIPLIERS.length; bit += 1) {
    if (absoluteTick & (1 << bit)) ratio = (ratio * MULTIPLIERS[bit]) >> 128n;
  }
  if (normalizedTick > 0) ratio = MAX_UINT256 / ratio;
  // TickMath redondea hacia arriba para preservar la correspondencia tick ↔ precio.
  return (ratio >> 32n) + ((ratio & Q32_MASK) === 0n ? 0n : 1n);
}

module.exports = { MIN_TICK, MAX_TICK, getSqrtPriceX96AtTick };
