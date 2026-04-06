# Smart Create Pool — Creación Automática de Posiciones LP

## Overview

La feature **Smart Create Pool** automatiza completamente la creación de nuevas posiciones Uniswap v3/v4. En lugar de ingresar manualmente el rango de precios y los montos de tokens, el sistema:

1. ✅ **Detecta tokens disponibles** en tu wallet con saldos
2. ✅ **Calcula el rango óptimo** basado en volatilidad histórica (ATR)
3. ✅ **Computa automáticamente** los montos de token0/token1
4. ✅ **Sugiere 3 perfiles** (conservador, balanceado, agresivo)
5. ✅ **Todo lo hace por ti** — solo verifica y confirma

---

## Flujo de Usuario

### Paso 1: Seleccionar Tokens (Token Selection)

1. Abre la página de Uniswap Pools
2. Conecta tu wallet (MetaMask, WalletConnect)
3. Haz clic en el botón **＋ Nueva posición LP** (en la barra de wallet)
4. Se abre el modal "Smart Create Pool"

**En el formulario:**
- **Red**: Elige la red (Ethereum, Arbitrum, etc.) — por defecto usa la conectada
- **Versión**: V3 o V4 (recomendado V3 por ahora)
- **Token 0 y Token 1**: Dropdown con tokens de tu wallet mostrando balance
  - Ej: `USDC — 1234.56 USDC`, `WETH — 0.42 WETH`
- **Fee**: Selecciona el tier de fee (0.01%, 0.05%, 0.3%, 1%)
  - Recomendado: 0.3% para pares estables/volátiles

Haz clic en **"Analizar rango"** para proceder.

### Paso 2: Seleccionar Rango (Range Selection)

El servidor calcula:
- ✅ **Precio actual** de ambos tokens
- ✅ **ATR(14)** basado en 100 candles 1h de Hyperliquid (si el asset está listado)
- ✅ **3 opciones de rango** basadas en múltiplos de ATR
- ✅ **Montos automáticos** para cada opción

**Las 3 opciones:**

| Preset | Múltiplo | Rango | Ancho | Perfil |
|--------|----------|-------|-------|---------|
| **Conservador** | ±5× ATR | Amplio | ~32% | Mayor seguridad contra IL, menos fees |
| **Balanceado** | ±3× ATR | Medio | ~19% | Balance ideal (recomendado) |
| **Agresivo** | ±1.5× ATR | Estrecho | ~9% | Máximas fees, mayor riesgo de IL |

**Cada tarjeta muestra:**
- Rango de precios (ej: $2,308 — $3,192)
- Ancho como porcentaje (ej: ±32%)
- Distribución de tokens (ej: 48% USDC / 52% WETH)
- Montos calculados (ej: 630.12 USDC + 0.23 WETH)
- Tip de riesgo/recompensa

**Selecciona uno** haciendo clic en la tarjeta → aparece **"Continuar con Balanceado"** (o el que eligiste).

### Paso 3: Confirmar (Review & Sign)

- **Resumen de la posición**: Pair, fee, rango, precio actual
- **Lista de transacciones**: Approvals + mint (si hay)
- Haz clic en **"Confirmar y firmar"**
- Firma las transacciones en tu wallet (puede ser 1-3 txs según approvals)

Una vez confirmadas → **¡Posición creada! ✓**

---

## Detalles Técnicos

### ATR Range Computation

1. **Fetch 100 candles 1h** para el asset volátil (ej: ETH en USDC/WETH pair)
   - Data source: Hyperliquid

2. **Calcula ATR(14)** usando la fórmula estándar de Wilder
   - Requiere >= 14 candles válidos
   - Si falla: fallback a ±% simple (5%, 3%, 1.5%)

3. **Rango = Current Price ± (Multiplier × ATR)**
   - Conservative: ±5 ATR
   - Balanced: ±3 ATR
   - Aggressive: ±1.5 ATR

### Token Weight Calculation

Para cada rango sugerido, se calcula **targetWeightToken0Pct** usando la fórmula de Uniswap v3 para concentrated liquidity:

```
sqrtP = sqrt(currentPrice)
sqrtL = sqrt(lowerPrice)
sqrtU = sqrt(upperPrice)

a0_virtual = (sqrtU - sqrtP) / (sqrtP * sqrtU)
a1_virtual = sqrtP - sqrtL

a0_usd = a0_virtual * currentPrice
a1_usd = a1_virtual

token0Pct = a0_usd / (a0_usd + a1_usd) * 100
```

Esto asegura que los montos depositados son **óptimos para el rango elegido** (máxima utilización de capital).

### Auto-Rebalance Calculation

El sistema **detecta automáticamente** qué tokens son estables y volátiles:

- **Estables**: USDC, USDT, DAI, LUSD, USDE, FDUSD
- **Volátiles**: Todo lo demás (ETH, BTC, ARB, etc.)

El monto total a desplegar se calcula como:
```
totalUsd = balance_stable + (balance_volatile × current_price)
```

Luego distribuye este USD según el `targetWeightToken0Pct` calculado.

---

## Configuración & Customización

### Known Tokens List

El sistema mantiene una lista de tokens "conocidos" por red (Ethereum, Arbitrum, etc.):

```javascript
ethereum: [
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  // ... más tokens
]
```

**Para agregar más tokens:** 
Edita `server/src/services/smart-pool-creator.service.js`, sección `KNOWN_TOKENS`.

### ATR Parameters

Editables en el servidor (línea ~49-60 en smart-pool-creator.service.js):

```javascript
const ATR_MULTIPLIERS = {
  conservative: { multiplier: 5, label: 'Conservador (±5× ATR)' },
  balanced: { multiplier: 3, label: 'Balanceado (±3× ATR)' },
  aggressive: { multiplier: 1.5, label: 'Agresivo (±1.5× ATR)' },
};
```

### Fallback Percentages

Si el servidor no puede calcular ATR (asset no listado en HL), usa estos fallbacks:

```javascript
const FALLBACK_MULTIPLIERS = {
  conservative: { multiplier: 0.05, label: 'Conservador (±5%)' },
  balanced: { multiplier: 0.03, label: 'Balanceado (±3%)' },
  aggressive: { multiplier: 0.015, label: 'Agresivo (±1.5%)' },
};
```

---

## Troubleshooting

### Error: "Network no soportada"
- Asegúrate de que has seleccionado una red soportada (Ethereum, Arbitrum, etc.)
- Si necesitas agregar una red: edita `SUPPORTED_NETWORKS` en `uniswap.service.js`

### Error: "Both tokens are stables"
- Ambos tokens son estables (ej: USDC + USDT)
- Selecciona un token estable + uno volátil (ej: USDC + WETH)

### Error: "No pool found for token pair"
- La pareja de tokens no existe en Uniswap con ese fee tier
- Intenta con otro fee tier (0.01%, 0.05%, 0.3%, 1%)

### Rango muy amplio / muy estrecho
- Si usas Conservador/Agresivo, los rangos pueden ser muy diferentes al Balanced
- Selecciona Balanced para empezar si no estás seguro

### Montos incorrectos
- Los montos se calculan basados en tu balance total en wallet
- Si tienes poco saldo de uno de los tokens, puede dar monto = 0
- Asegúrate de tener balance en ambos tokens

---

## Flujo Interno (Developer Docs)

### 1. Frontend: SmartCreatePoolModal.jsx
- Step 1: Token select form
- Step 2: Range preset cards
- Step 3: Transaction review + signing

Props:
```jsx
<SmartCreatePoolModal
  wallet={{ address, chainId, isConnected }}
  sendTransaction={fn}
  defaults={{ network, version }}
  meta={networksMeta}
  onClose={fn}
  onFinalized={fn}
/>
```

### 2. API Calls

**GET /uniswap/smart-create/token-list?network=ethereum**
Returns known tokens for the network with balances.

**POST /uniswap/smart-create/suggest**
```json
{
  "network": "ethereum",
  "version": "v3",
  "walletAddress": "0x...",
  "token0Address": "0x...",
  "token1Address": "0x...",
  "fee": 3000,
  "totalUsdHint": 10000 // opcional
}
```

Returns:
```json
{
  "token0": { "symbol": "USDC", "decimals": 6, "balance": "1234.56", ... },
  "token1": { "symbol": "WETH", "decimals": 18, "balance": "0.42", ... },
  "currentPrice": 2750.40,
  "volatileAsset": "ETH",
  "atr14": 88.32,
  "suggestions": [
    {
      "preset": "conservative",
      "label": "Conservador (±5× ATR)",
      "rangeLowerPrice": 2308.4,
      "rangeUpperPrice": 3192.0,
      "targetWeightToken0Pct": 48.2,
      "amount0Desired": "630.12",
      "amount1Desired": "0.23",
      "widthPct": 32.1
    },
    // balanced, aggressive...
  ]
}
```

### 3. Backend Service: smart-pool-creator.service.js

Key functions:
- `getSuggestions(params)` — Main orchestration
- `fetchAtr14(volatileAsset)` — ATR calculation
- `computeRangeSuggestions(price, atr)` — Presets
- `computeToken0Pct(price, lower, upper)` — Weight formula
- `computeAmountsFromWeight(pct, usd, price, decimals)` — Amount splits

---

## Performance & Limitations

| Aspect | Details |
|--------|---------|
| **ATR data** | 100 candles (1h), ~4 hours of history |
| **Supported assets** | Only HL-listed assets (ETH, BTC, most major altcoins) |
| **Fee tiers** | V3: 100, 500, 3000, 10000 bps. V4: configured per pool |
| **Cache** | ATR cached 5 min, token list on each page load |
| **Networks** | Ethereum, Arbitrum, Base, Optimism, Polygon |
| **Max tokens** | Unlimited (loads from known list + chain lookup) |

---

## Future Enhancements

Posibles mejoras:
- 🔧 **Historical range analysis**: Show past price extremes
- 🔧 **Backtesting**: Simulate LP performance with chosen range
- 🔧 **Fee tier optimizer**: Suggest best fee based on historical volume
- 🔧 **Position management**: Auto-rebalance after creation
- 🔧 **Multi-leg strategies**: Create multiple positions with complementary ranges

---

## Support & Debugging

### Enable verbose logging
Add to env:
```bash
DEBUG=smart:* node server.js
```

### Check server logs
```bash
grep "smart_pool_creator" logs/app.log
```

### Manual API test
```bash
curl -X POST http://localhost:3000/uniswap/smart-create/suggest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "network": "ethereum",
    "version": "v3",
    "walletAddress": "0x...",
    "token0Address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "token1Address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "fee": 3000
  }'
```

---

## Summary

**Smart Create Pool** transforms LP creation from a multi-step, manual process into a guided 3-step wizard:

1. Pick tokens + fee
2. Choose ATR-based range (conservative/balanced/aggressive)
3. Verify + sign

Everything else is automated: balance detection, range calculation, token ratio computation, transaction building.

**Perfect for:** New LPs, DeFi beginners, anyone who wants a "set and forget" LP experience without manual calculations.
