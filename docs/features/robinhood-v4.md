# Robinhood Chain (Uniswap v4)

Robinhood mainnet (chainId 4663) está registrada en
`server/src/services/uniswap/networks.js`. Sólo v4 se expone para crear LPs;
los despliegues v3 (factory, quoter, swapRouter) se usan únicamente para los
swaps de fondeo y cierre de esas posiciones v4.

## Tokens

- WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73` (wrapped native; el gas es ETH).
- USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimales: es el
  estable de liquidación de la red y ocupa el lugar de USDC en cierres,
  balances y en el rango recomendado ATR (ETH/USDG ≡ ETH/USDC).

## Supuestos y riesgos aceptados

- USDG se valora a $1 igual que los demás estables; no se cubre el riesgo de depeg.
- Fee `0x800000` en una PoolKey es la bandera de comisión dinámica, no un
  porcentaje: se conserva intacta y la UI la muestra como "Comisión dinámica".
- Un hook sin returns-delta sólo acredita compatibilidad con la matemática
  CLAMM: no audita el contrato ni garantiza acceso, liquidez o ausencia de
  reverts. `hookData` se envía vacío; un hook que exija datos necesitaría un
  adaptador explícito.

## Verificación

Las direcciones se comprobaron con lecturas on-chain (bytecode y referencias
cruzadas entre contratos). Hay dos Universal Router desplegados
(`0x8876789976decbfcbbbe364623c63652db8c0904`, el que usa el código, y
`0x204FAca1764B154221e35c0d20aBb3c525710498`); ambos devuelven el PoolManager
`0x8366a39cc670b4001a1121b8f6a443a643e40951` en `poolManager()`.

## Fuentes

- https://docs.robinhood.com/chain/connecting/
- https://docs.robinhood.com/chain/contracts/
- https://api.etherscan.io/v2/chainlist (4663 admitida para el escaneo de NFTs)
- https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts
- https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/robinhood.json
