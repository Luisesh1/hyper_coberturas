'use strict';

// Prueba opt-in: lee estado de Base Sepolia, pero nunca firma ni transmite una
// transacción. CI no depende de una red externa; para ejecutarla se necesitan:
// BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_HOOK_ADDRESS y BASE_SEPOLIA_POOL_KEY_JSON.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JsonRpcProvider, Interface } = require('ethers');
const {
  createHookHarness,
  computePoolStateSlot,
  HOOK_FLAG_BITS,
  ALL_HOOK_MASK,
  LP_FEE_OVERRIDE_FLAG,
} = require('./helpers/evm.js');

const BASE_SEPOLIA_CHAIN_ID = 84_532n;
const POOL_MANAGER = '0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317';
const required = ['BASE_SEPOLIA_RPC_URL', 'BASE_SEPOLIA_HOOK_ADDRESS', 'BASE_SEPOLIA_POOL_KEY_JSON'];
const enabled = required.every((name) => process.env[name]);
const params = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

function decodeTick(slot0) {
  const word = BigInt(slot0);
  const unsigned = (word >> 160n) & ((1n << 24n) - 1n);
  return Number(unsigned >= (1n << 23n) ? unsigned - (1n << 24n) : unsigned);
}

test('fork de Base Sepolia: lee PoolManager y ejecuta localmente el ciclo del hook verificado', { skip: !enabled && `requiere ${required.join(', ')}` }, async () => {
  const provider = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL, Number(BASE_SEPOLIA_CHAIN_ID));
  const network = await provider.getNetwork();
  assert.equal(network.chainId, BASE_SEPOLIA_CHAIN_ID, 'el RPC debe ser Base Sepolia (84532)');

  const [poolManagerCode, deployedHookCode] = await Promise.all([
    provider.getCode(POOL_MANAGER),
    provider.getCode(process.env.BASE_SEPOLIA_HOOK_ADDRESS),
  ]);
  assert.notEqual(poolManagerCode, '0x', 'el PoolManager oficial debe existir en Base Sepolia');
  assert.notEqual(deployedHookCode, '0x', 'la dirección debe contener el hook desplegado');

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'VolatilityShieldV1.json'), 'utf8'));
  const iface = new Interface(artifact.abi);
  const returnData = await provider.call({
    to: process.env.BASE_SEPOLIA_HOOK_ADDRESS,
    data: iface.encodeFunctionData('getHookPermissions'),
  });
  const [permissions] = iface.decodeFunctionResult('getHookPermissions', returnData);
  let expectedMask = 0n;
  for (const [name, bit] of Object.entries(HOOK_FLAG_BITS)) if (permissions[name]) expectedMask |= BigInt(bit);
  assert.equal(BigInt(process.env.BASE_SEPOLIA_HOOK_ADDRESS) & ALL_HOOK_MASK, expectedMask);
  assert.equal(expectedMask, BigInt(HOOK_FLAG_BITS.beforeSwap), 'el hook desplegado sólo declara beforeSwap');

  const key = JSON.parse(process.env.BASE_SEPOLIA_POOL_KEY_JSON);
  const storageSlot = computePoolStateSlot(key);
  const remoteSlot0 = await provider.getStorage(POOL_MANAGER, storageSlot);
  const tick = decodeTick(remoteSlot0);

  // El bytecode del hook se ejecuta en la EVM local sobre el slot0 que se leyó
  // del PoolManager real. No hay firma, nonce ni estado escrito en Base Sepolia.
  const harness = await createHookHarness();
  const localKey = { ...key, hooks: harness.hookAddress };
  await harness.setSlot0({ key: localKey, tick });
  const first = await harness.beforeSwap({ key: localKey, params, timestamp: 1_000n });
  const second = await harness.beforeSwap({ key: localKey, params, timestamp: 1_300n });
  const third = await harness.beforeSwap({ key: localKey, params, timestamp: 1_600n });
  for (const result of [first, second, third]) {
    assert.equal(result.delta, 0n);
    assert.equal(result.selector, harness.iface.getFunction('beforeSwap').selector);
    assert.ok(result.fee >= LP_FEE_OVERRIDE_FLAG + 500n && result.fee <= LP_FEE_OVERRIDE_FLAG + 6000n);
  }
});
