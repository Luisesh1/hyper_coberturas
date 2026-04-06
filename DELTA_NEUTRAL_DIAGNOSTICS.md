# Delta-Neutral Protection Diagnostics & Troubleshooting

## Overview

Delta-neutral protections are fully operational and monitored automatically. This guide helps diagnose and resolve any issues.

## Quick Diagnostic Check

### 1. Get Protection List
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-api.com/uniswap/protected-pools
```

Look for protections with `protectionMode: "delta_neutral"`.

### 2. Run Detailed Diagnostics
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-api.com/uniswap/protected-pools/{protection_id}/diagnose
```

This returns a comprehensive diagnostic report including:
- **Pool snapshot validity**: Checks if pool data is complete
- **Strategy state**: Current status and any errors
- **Metrics**: Delta, gamma, target qty, and calculated values
- **Hyperliquid account**: Margin, position info, liquidation distance

## Understanding Diagnostic Output

### Strategy State Status

- **healthy**: Protection is working normally
- **risk_paused**: Hedge temporarily paused due to:
  - Liquidation distance < 10%
  - Missing isolated margin mode
  - Manual long position detected on same asset
- **degraded_partial**: Pool is not eligible for delta-neutral (outside stable+volatile pair definition)
- **boundary_watch**: Price near range boundary
- **partial_hedge_warning**: TWAP execution partially completed

### Common Issues & Solutions

#### Issue: "No open positions yet" in Hyperliquid

**Diagnosis**:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-api.com/uniswap/protected-pools/{id}/diagnose | jq '.checks'
```

**Possible causes**:

1. **Wrong protection mode** (showing delta_neutral but is static/dynamic)
   - Check `protectionMode` in response
   - Recreate protection with correct mode selection in UI

2. **Strategy is risk_paused**
   - Check `strategyState.status`
   - Check `strategyState.lastError`
   - Solutions:
     - If liquidation distance is low: deposit margin to HL account
     - If margin mode issue: ensure isolated margin is enabled on HL
     - If manual long position: close it first

3. **Pool not eligible**
   - Delta-neutral requires: one stable token (USDC/USDT/DAI) + one volatile token
   - Check `checks.metrics.eligible` and `.reason`

4. **Metrics calculation failed**
   - Check pool snapshot completeness in `checks.poolSnapshot`
   - Check price validity: `checks.metrics.volatilePriceUsd`

#### Issue: Strategy status is degraded_partial

**Solution**:
1. Check `strategyState.lastError` for specific reason
2. If pool is out of range or liquidity too low:
   - Adjust pool configuration
   - Or deactivate and recreate protection
3. Run recovery:
   ```bash
   # This will re-evaluate and attempt to open position
   curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
     https://your-api.com/uniswap/protected-pools/refresh
   ```

#### Issue: High liquidation distance warning

**Symptoms**:
- `distanceToLiqPct < 10` in diagnostics
- Strategy status becomes `boundary_watch` or `risk_paused`

**Solutions**:
- Auto margin top-up is attempted (max 3x per 24h)
- Manually deposit margin to HL account in isolated mode:
  1. Go to Hyperliquid
  2. Find the asset position (short)
  3. Click "Deposit" to add margin to isolated balance
  4. Minimum 1.2x notional recommended

#### Issue: Rebalance not triggering

**Diagnosis**:
- Check `strategyState.lastRebalanceAt` timestamp
- Check `strategyState.lastError`
- Expected triggers:
  - Price moved >= `baseRebalancePriceMovePct` (default 3%)
  - Timer interval elapsed (default 6 hours)
  - No position yet and `targetQty > 0` (bootstrap)
  - Price crossed range boundary

**Solutions**:
- If price hasn't moved enough, wait for movement or adjust `baseRebalancePriceMovePct`
- Check `rebalanceIntervalSec` setting (minimum 60 seconds, default 6h)
- Verify position exists: check Hyperliquid account for short position

## Server-Side Validation

### Run Validation Script
```bash
node server/src/scripts/validate-delta-neutral.js
```

This will:
- ✅ List all delta-neutral protections
- ✅ Check each one for issues
- ✅ Attempt recovery for degraded protections
- 📊 Show summary of healthy vs degraded

### Manual Validation in Database

```sql
-- List all delta-neutral protections with key info
SELECT 
  id, user_id, inferred_asset, status,
  strategy_state_json::json->>'status' as strategy_status,
  hedge_size, hedge_notional_usd,
  (strategy_state_json::json->>'lastError') as last_error,
  created_at, updated_at
FROM protected_uniswap_pools
WHERE protection_mode = 'delta_neutral'
ORDER BY created_at DESC;

-- Check recent rebalance activity
SELECT 
  protected_pool_id, reason, execution_mode,
  actual_qty_before, actual_qty_after,
  created_at
FROM protected_pool_delta_rebalance_logs
WHERE created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

## Configuration Reference

### Delta-Neutral Settings (per protection)

| Setting | Default | Range | Impact |
|---------|---------|-------|--------|
| `targetHedgeRatio` | 1.0 | 0.1-2.0 | Hedge size relative to pool delta (1 = full hedge) |
| `bandMode` | adaptive | fixed/adaptive | Adjust rebalance threshold by volatility |
| `baseRebalancePriceMovePct` | 3% | 0.1-50% | Price movement threshold for rebalance |
| `rebalanceIntervalSec` | 6h | 60-86400 | Maximum time between rebalances |
| `minRebalanceNotionalUsd` | $50 | >0 | Minimum drift in USD to trigger timer-based rebalance |
| `leverage` | 10x | 1-100x | HL trading leverage (isolated margin) |
| `maxSlippageBps` | 20 | 1-500 | Maximum execution slippage in basis points |
| `twapMinNotionalUsd` | $10k | >0 | Orders >= this use TWAP instead of IOC |

### Server Configuration (environment)

```env
# Delta-Neutral monitoring
DELTA_NEUTRAL_LOOP_MS=2000           # Tick interval (faster = more responsive)
DELTA_NEUTRAL_EVAL_MS=30000          # Full evaluation interval
```

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Active protections**: Count of `status='active' AND protectionMode='delta_neutral'`
2. **Healthy ratio**: Count where `strategy_state->>'status'='healthy'`
3. **Rebalance frequency**: Count in `delta_rebalance_logs` per hour
4. **Error rate**: Count where `strategy_state->>'status' IN ('risk_paused', 'degraded_partial')`

### Example Alert Conditions

```sql
-- Alert: Protection stuck without rebalance for 24h
SELECT id, inferred_asset 
FROM protected_uniswap_pools
WHERE protection_mode = 'delta_neutral' 
  AND status = 'active'
  AND (strategy_state_json::json->>'lastRebalanceAt')::bigint < EXTRACT(epoch FROM now() - interval '24 hours') * 1000
  AND (strategy_state_json::json->>'status') = 'healthy';

-- Alert: Risk paused protection
SELECT id, inferred_asset, strategy_state_json::json->>'lastError' as error
FROM protected_uniswap_pools  
WHERE protection_mode = 'delta_neutral'
  AND (strategy_state_json::json->>'status') = 'risk_paused';
```

## Recovery Procedures

### Force Rebalance

If a protection is healthy but not rebalancing:
```javascript
// POST /uniswap/protected-pools/refresh
// This re-evaluates all protections and may trigger overdue rebalances
```

### Manual Bootstrap Retry

If bootstrap failed (found in logs):
```bash
# Database - mark as needs re-evaluation
UPDATE protected_uniswap_pools
SET strategy_state_json = jsonb_set(
  strategy_state_json,
  '{lastRebalanceAt}',
  'null'::jsonb
)
WHERE id = {protection_id};

# API - trigger refresh
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-api.com/uniswap/protected-pools/refresh
```

### Deactivate & Recreate

If protection is severely degraded:
1. **Deactivate**: 
   ```bash
   curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
     https://your-api.com/uniswap/protected-pools/{id}/deactivate
   ```
2. **Close position in HL**: Manually close the short if it exists
3. **Recreate**: Start new protection from UI

## Performance Tips

1. **Reduce monitoring overhead**: Increase `DELTA_NEUTRAL_LOOP_MS` if you have many protections
2. **Batch rebalances**: Use higher `baseRebalancePriceMovePct` to reduce execution frequency
3. **Use TWAP for large orders**: Set `twapMinNotionalUsd` appropriately
4. **Monitor margin**: Check HL account margin regularly to avoid liquidations

## Support

For persistent issues:
1. Collect diagnostic output: `GET /uniswap/protected-pools/{id}/diagnose`
2. Check server logs: `grep "protected_pool_delta" logs/`
3. Run validation script: `node server/src/scripts/validate-delta-neutral.js`
4. Review database state: Check strategy_state_json and recent rebalance logs
