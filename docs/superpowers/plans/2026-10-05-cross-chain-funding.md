# Fondeo cross-chain — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el asistente «Crear orquestador» lea saldos en todas las redes, planifique y ejecute bridges (Li.Fi / Across) hacia la red del LP con perfiles de gas Bajo/Medio/Alto y costos detallados.

**Architecture:** dos fases. Un subsistema nuevo `server/src/services/cross-chain/` (perfiles de gas, oráculo de comisiones, saldos multi-red, proveedores de bridge, planificador, servicio de planes y monitor) trae el déficit de cada lado a la red destino; después corre el `buildFundingPlan` actual sin cambios. El cliente añade un panel multi-red en Fondeo, un paso «Traer fondos» y un diálogo de reanudación.

**Tech Stack:** Node 22 + Express + ethers 6 + pg + zod (servidor, `node:test`); React 18 + Vite + vitest + Testing Library (cliente); Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-05-cross-chain-funding-design.md`

## Global Constraints

- Perfiles: `low` = prio p10, maxFee = baseNext × 81/64 + prio, gasLimit +10 %; `medium` = p50, ×2, +20 %; `high` = p90, ×3, +30 %.
- Orbit (arbitrum, robinhood): prio 0 en todos los perfiles; L1 «incluida» (solo informativa). OP (base, optimism): L1 aditiva. Polygon: prio ≥ 25 gwei.
- `eth_feeHistory` con 20 bloques y percentiles `[10, 50, 90]`, caché 15 s por red.
- Umbral de viabilidad por defecto 3 %; reconfirmación si el costo recotizado supera en más del 20 % al mostrado.
- Colchón por lado `1.05` (igual que `DEFAULT_POOL_VALUE_BUFFER`); no hay cross-chain si lo local ≥ 93 % del objetivo.
- Proveedores: Li.Fi `https://li.quest/v1` y Across `https://app.across.to/api`; `to` y `spender` siempre en la allowlist de `bridge-allowlist.js`; destinatario = la misma wallet.
- Trinquete de tamaño (`scripts/hotspot-baseline.json`): `smart-pool-creator.service.js`, `UnifiedLpWizard.jsx`, `useUnifiedLpFlow.js` y `useWalletConnection.js` no pueden crecer en bytes. La lógica nueva va a archivos nuevos y lo que se añade a esos archivos se compensa extrayendo código.
- Colores del cliente solo con tokens `--uni-*`.
- Flag `CROSS_CHAIN_FUNDING` = `off` (por defecto) | `read` | `execute`.
- Copy de la UI en español.

## Review Focus

1. **Nativo después de ERC20 en la misma red:** el gas gastado por los envíos previos reduce el saldo; `prepareStep` debe recortar el monto nativo a `saldo − reserva de los pasos pendientes de esa red` (test en Task 11).
2. **Doble envío:** recargar o hacer doble clic en un paso que ya tiene `txHash` nunca devuelve una tx nueva salvo `speedUp`; `submitted` es idempotente con el mismo hash y rechaza otro (Task 11).
3. **Cotización caducada o más cara al firmar:** se recotiza siempre y se devuelve `requiresReconfirm` si el costo sube más del 20 % (Task 11).
4. **Decimales y precio ausente:** USDC/USDG con 6 decimales, WETH/POL con 18; un token sin precio se excluye con motivo «sin precio» (Task 8).
5. **Red caída o lenta:** una red que falla o tarda más de 15 s queda «no leída» y el análisis sigue (Task 4).

---

### Task 1: Perfiles de gas (`fee-profiles.js`)
**Files:** Create `server/src/services/cross-chain/fee-profiles.js`; Test `server/test/cross-chain-fee-profiles.test.js`.
**Produces:** `PROFILE_IDS`, `PROFILES`, `FEE_HISTORY_BLOCKS`, `FEE_HISTORY_PERCENTILES`, `getProfile(id)`, `getChainFamily(network)` → `'l1'|'orbit'|'op'|'polygon'`, `computeProfileFees({ network, profile, feeHistory })` → `{ profile, family, baseFeeNextWei, maxPriorityFeePerGas, maxFeePerGas, expectedGasPriceWei }` (bigint), `applyGasLimitBuffer(gasUnits, profile)` → bigint, `nextProfile(id)`, `bumpReplacementFees(prev, next)` → fees ≥ prev × 1.125.
- [ ] Tests: p10/p50/p90 median per column; orbit → prio 0; polygon floor; low maxFee = base × 81/64 + prio; ordering low<medium<high; unknown profile throws `ValidationError`; buffer rounding up; bump ≥ 12.5 %.
- [ ] Implement, run `node --test test/cross-chain-fee-profiles.test.js`, commit.

### Task 2: Migración 030 + calibración de gas
**Files:** Create `server/src/db/migrations/030_cross_chain_funding.sql` (`cross_chain_plans`, `cross_chain_steps`, `gas_observations`), `server/src/repositories/gas-observation.repository.js`, `server/src/services/cross-chain/gas-calibration.js`; Test `server/test/cross-chain-gas-calibration.test.js`.
**Produces:** repo `insert(obs, executor)`, `getP95GasUsed({ network, kind, minSamples=5, lookback=200 }, executor)` → number|null. Calibration `createGasCalibration({ repository, now })` → `{ getCalibratedGasUnits({network,kind}), observeReceipt({ network, provider, txHash, kind, profile, estimatedGas }), observeTxHashes({ network, provider, txHashes }), classifyTxInput(input) }`. `observeReceipt` reads the raw receipt (`eth_getTransactionReceipt`, gives `effectiveGasPrice` and the OP `l1Fee`), returns `{ status: 'success'|'reverted', gasUsed, effectiveGasPriceWei, l1FeeWei, blockNumber }` or null, and stores only successes.
- [ ] Tests: SQL params, p95 below minSamples → null, cache TTL, selector classifier (approve, permit2, deposit, withdraw), reverted receipts not stored.

### Task 3: Oráculo de comisiones (`fee-oracle.js`)
**Files:** Create `server/src/services/cross-chain/fee-oracle.js`; Test `server/test/cross-chain-fee-oracle.test.js`.
**Consumes:** Task 1, Task 2 `getCalibratedGasUnits`, `GAS_PER_TX_TYPE` (adds `bridge: 300000` to `gas-cost-estimator.js`).
**Produces:** `createFeeOracle({ getProvider, getCalibratedGasUnits, now })` → `{ getFeeHistory(network), getProfileFees({network,profile}), estimateTxCosts({ network, profile, txs:[{kind,label,to?,data?,value?,providerGasLimit?}], from?, nativeUsdPrice? }), compareProfiles(args), clearCache() }`. `estimateTxCosts` returns `{ network, profile, family, profilesMatter, fees, txs:[{ kind,label,gasUnits,gasLimit,source,l1FeeWei,l1Mode,expectedWei,maxWei,expectedUsd,maxUsd,l1Usd }], totalExpectedWei, totalMaxWei, totalExpectedUsd, totalMaxUsd }`. Gas units: `estimateGas` → `providerGasLimit` → calibrated → table. L1: OP `GasPriceOracle.getL1Fee` (o `getL1FeeUpperBound` sin calldata); Orbit `NodeInterface.gasEstimateL1Component` (solo informativa). Uses `rpcSender(provider)` (the provider itself or `providerConfigs[0].provider` for a `FallbackProvider`).
- [ ] Tests with a fake provider: cache, OP additive L1 with ×1.2 in the max, Orbit L1 not added, estimateGas failure → provider gas → table, USD conversion, compareProfiles.

### Task 4: Saldos multi-red
**Files:** Create `server/src/services/cross-chain/pricing.js` (`usdPriceForSymbol(symbol, prices)`), `server/src/services/cross-chain/multichain-balances.js`; Test `server/test/cross-chain-multichain-balances.test.js`.
**Produces:** `MAINNET_NETWORKS`, `createMultichainBalances({ getWalletAssets, networks, timeoutMs=15000 })` → `{ getMultichainBalances({ walletAddress, networks? }) }` → `{ networks:[{ network,label,chainId,nativeSymbol,status:'ok'|'error',error?,nativeBalanceRaw,assets }], totalUsd }`.
- [ ] Tests: one network throws → `error`, others ok; timeout → `error`; totalUsd sums; base-sepolia excluded.

### Task 5: Allowlist + proveedor Li.Fi
**Files:** Create `server/src/services/cross-chain/bridge-allowlist.js`, `server/src/services/cross-chain/providers/lifi.provider.js`, `server/src/services/cross-chain/providers/approval.js` (`buildApprovalTx`, `decodeApproval`); Test `server/test/cross-chain-lifi-provider.test.js`.
**Produces:** a normalized quote `{ provider, tool, fromNetwork, toNetwork, fromToken, toToken, fromAmountRaw, toAmountRaw, toAmountMinRaw, feeCosts:[{name,amountUsd,included}], approvalTxs:[{to,data,value,spender}], tx:{to,data,value,chainId,gasLimit}, etaSec, expiresAt, ref }` and `status({ txHash, fromNetwork, toNetwork, ref })` → `{ status:'pending'|'delivered'|'failed'|'refunded', receivedRaw|null, message? }`. `assertAllowedTarget({ provider, network, to })` throws `AppError` `BRIDGE_TARGET_NOT_ALLOWED`.
- [ ] Tests: quote mapping, approval built only for ERC20, `to` outside the allowlist rejected, status mapping (DONE/COMPLETED, DONE/REFUNDED, FAILED, PENDING, NOT_FOUND), HTTP error → `BRIDGE_QUOTE_FAILED`.

### Task 6: Proveedor Across
**Files:** Create `server/src/services/cross-chain/providers/across.provider.js`; Test `server/test/cross-chain-across-provider.test.js`.
**Produces:** same interface as Task 5 (`/swap/approval`, `/deposit/status`).
- [ ] Tests: approval decoded and spender checked, fees mapped, statuses (filled, pending, refunded, expired → failed, DepositNotFound → pending).

### Task 7: Déficit por lado
**Files:** Create `server/src/services/cross-chain/side-deficits.js`; Test `server/test/cross-chain-side-deficits.test.js`.
**Produces:** `computeSideDeficits({ targetUsd, weightToken0Pct, token0, token1, localAssets:[{address,isNative,usableUsd}], wrappedNativeAddress, buffer=1.05, minDeployableRatio=0.93 })` → `{ needUsd, haveUsd, otherLocalUsd, localUsableUsd, deficitUsd:{token0,token1}, totalDeficitUsd, needsCrossChain }`, `deliveryTokenFor(token, wrappedNativeAddress)`.
- [ ] Tests: enough locally → no cross-chain; other local assets split proportionally; native counts for WETH and address(0).

### Task 8: Planificador de bridges
**Files:** Create `server/src/services/cross-chain/bridge-planner.js`; Test `server/test/cross-chain-bridge-planner.test.js`.
**Consumes:** Tasks 3, 5, 6, 7.
**Produces:** `buildBridgePlan({ walletAddress, destination:{ network, nativeBalanceRaw, gasNeededRaw, nativePriceUsd, sides:[{ side, deficitUsd, deliveryToken:{address,symbol,decimals,priceUsd} }] }, sources:[{ id, network, address, symbol, decimals, isNative, balanceRaw, priceUsd }], profile, thresholdPct, forcedSources, disabledSources, maxSlippageBps, providers, feeOracle, nativePrices })` → `{ steps, sourcesView, deliveredUsd, uncoveredUsd, costsByProfile }`; `orderSteps(steps)`.
- [ ] Tests: cheapest provider wins and the other is reported as the alternative; excluded above the threshold unless forced; disabled source skipped; gas carried first when the destination lacks gas; ERC20 before native within a network; a native source keeps its reserve; no price → «sin precio»; decimals 6/18.

### Task 9: Repositorio de planes
**Files:** Create `server/src/repositories/cross-chain-plan.repository.js`; Test `server/test/cross-chain-plan.repository.test.js`.
**Produces:** `createPlan({ userId, walletAddress, destinationNetwork, profile, thresholdPct, request, analysis, steps }, executor)`, `getPlan(userId, planId)`, `findActivePlan(userId, walletAddress)`, `updateStep(planId, order, patch)`, `updatePlan(planId, patch)`, `listInFlightSteps()`, `recomputePlanStatus(planId)`.

### Task 10: Servicio — análisis y alta de plan
**Files:** Create `server/src/services/cross-chain/cross-chain-funding.service.js`; Test `server/test/cross-chain-funding-analyze.test.js`.
**Produces:** `createCrossChainFundingService(deps)` → `analyze(input)`, `createPlan({ userId, input })` (re-runs `analyze` on the server; rejects `NO_CROSS_CHAIN_NEEDED` / `ACTIVE_PLAN_EXISTS`).
- [ ] Tests: no deficit → `needsCrossChain:false`; an unreadable destination → `DESTINATION_UNREADABLE`; the LP gas reserve is profile-based; the categories add up.

### Task 11: Servicio — ejecución
**Files:** Modify `cross-chain-funding.service.js`; Test `server/test/cross-chain-funding-execution.test.js`.
**Produces:** `getPlanView`, `getActivePlan`, `prepareStep({ userId, planId, order, speedUp })` → `{ requiresReconfirm, previousCostUsd, newCostUsd, txs:[{kind,chainId,to,data,value,gas,maxFeePerGas,maxPriorityFeePerGas,nonce?}] }`, `submitStep({ userId, planId, order, kind, txHash, nonce, fees })`, `skipStep`, `discardPlan`, `continueWithArrived`.
- [ ] Tests for Review Focus 1–3, speed-up bump and same nonce, skip, discard, continue.

### Task 12: Monitor + calibración desde el orquestador
**Files:** Create `server/src/services/cross-chain/cross-chain-monitor.service.js`; Modify `server/src/bootstrap/infra.js`, `server/src/services/lp-orchestrator.service.js` (fire-and-forget `observeTxHashes`); Test `server/test/cross-chain-monitor.test.js`.
- [ ] Tests: signed → source_confirmed with real cost and `walletOverrodeFees`; reverted → failed; delivered and refunded via the provider; plan status recomputed; errors isolated per step.

### Task 13: Config, schemas y rutas
**Files:** Modify `server/src/config/index.js` (`crossChainFunding.mode`), `server/src/routes/index.js`; Create `server/src/schemas/cross-chain.schema.js`, `server/src/routes/cross-chain.routes.js`; Test `server/test/cross-chain.routes.test.js`.
Endpoints under `/api/cross-chain`: `GET /config`, `POST /funding-analysis`, `POST /plans`, `GET /plans/active?walletAddress=`, `GET /plans/:id`, `POST /plans/:id/steps/:order/prepare`, `POST /plans/:id/steps/:order/submitted`, `POST /plans/:id/steps/:order/skip`, `POST /plans/:id/discard`, `POST /plans/:id/continue`. `off` → 404; execution routes require `execute` (403 `FEATURE_DISABLED`).

### Task 14: Cliente — API y fees en las transacciones
**Files:** Modify `client/src/services/api.js` (`crossChainApi`), `client/src/lib/wallet/transaction-utils.js` (`buildTransactionParams` sends `maxFeePerGas`, `maxPriorityFeePerGas`, `nonce` when present); Test `client/src/lib/wallet/transaction-utils.test.js`.

### Task 15: Cliente — panel de fondeo multi-red
**Files:** Create `client/src/features/cross-chain-funding/useCrossChainFunding.js`, `CrossChainFundingPanel.jsx`, `CrossChainFundingPanel.module.css`, `format.js`; Test `CrossChainFundingPanel.test.jsx`.
- [ ] Balances table with roles and reasons, profile selector (default `low`), steps with costs (expected and max), categories, forcing and disabling sources, «Traer fondos» disabled in `read` mode.

### Task 16: Cliente — integración en el asistente (Fondeo)
**Files:** Create `client/src/features/lp-wizard/FundingStepSection.jsx`, `client/src/features/lp-wizard/wizardConstants.js`, `client/src/features/lp-wizard/useCrossChainStep.js`; Modify `UnifiedLpWizard.jsx`, `useUnifiedLpFlow.js` (extract constants to stay under the hotspot baseline).
- [ ] `npm run check:hotspots` green; the existing wizard tests are green.

### Task 17: Cliente — «Traer fondos»
**Files:** Create `client/src/features/cross-chain-funding/BringFundsStep.jsx`, `useBringFunds.js`; Test `BringFundsStep.test.jsx`.
- [ ] Sequential signing per network, consecutive signing across networks, reconfirm, speed-up, wait or continue with what arrived, protection configurable in parallel, phase 2 → `refreshFundingPlan` + `handlePrepareReview`.

### Task 18: Cliente — reanudar
**Files:** Create `client/src/features/cross-chain-funding/ResumePlanDialog.jsx`; Modify `client/src/features/lp-adopt/CreateOrchestratorChooser.jsx` (or where the wizard opens); Test.

### Task 19: e2e, contrato y CI
**Files:** Create `e2e/cross-chain-funding.spec.js` (API mocked with `page.route`), `server/test-contract/cross-chain-providers.contract.js`, script `test:providers` in `server/package.json`, and a non-blocking job in `.github/workflows/ci.yml`.

### Task 20: Docs
**Files:** `.env.example`(s), `DEPLOYMENT.md` (`CROSS_CHAIN_FUNDING`, `LIFI_API_KEY`, `ACROSS_API_URL`); vault note.
