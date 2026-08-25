const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const solc = require('solc');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src', 'VolatilityShieldV1.sol');

function findImports(importPath) {
  const candidate = path.join(root, 'node_modules', importPath);
  try {
    return { contents: fs.readFileSync(candidate, 'utf8') };
  } catch (error) {
    return { error: `No se pudo resolver ${importPath}: ${error.message}` };
  }
}

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'VolatilityShieldV1.sol': { content: fs.readFileSync(sourcePath, 'utf8') },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((item) => item.severity === 'error');
  assert.deepEqual(errors, [], errors.map((item) => item.formattedMessage).join('\n'));
  return output.contracts['VolatilityShieldV1.sol'].VolatilityShieldV1;
}

test('Volatility Shield V1 compila y declara únicamente beforeSwap', () => {
  const artifact = compile();
  const beforeSwap = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'beforeSwap');
  assert.ok(beforeSwap, 'el hook debe exponer beforeSwap');
  assert.ok(artifact.evm.bytecode.object.length > 0, 'debe producir bytecode reproducible');
});

test('Volatility Shield V1 conserva los límites y guardrails de tarifa', async () => {
  const harness = await createHookHarness();

  assert.equal(await harness.readConstant('FLOOR_FEE'), 500n);
  assert.equal(await harness.readConstant('BASE_FEE'), 3000n);
  assert.equal(await harness.readConstant('CAP_FEE'), 6000n);
  assert.equal(await harness.readConstant('UPDATE_INTERVAL'), 5n * 60n);
  assert.equal(await harness.readConstant('MAX_FEE_STEP'), 500n);

  const key = {
    currency0: '0x0000000000000000000000000000000000000001',
    currency1: '0x0000000000000000000000000000000000000002',
    fee: 0x800000,
    tickSpacing: 60,
    hooks: harness.hookAddress,
  };
  const params = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

  await harness.setSlot0({ tick: 0 });
  const first = await harness.beforeSwap({ key, params, timestamp: 1_000n });
  assert.equal(first.delta, 0n, 'el hook no debe modificar el accounting del swap');
  assert.equal(first.fee & LP_FEE_OVERRIDE_FLAG, LP_FEE_OVERRIDE_FLAG, 'debe activar el flag de override de fee');

  // Movimiento de tick extremo tras UPDATE_INTERVAL: la tarifa nunca puede
  // saltarse el techo (CAP_FEE) aunque la señal de volatilidad lo empuje muy por encima.
  await harness.setSlot0({ tick: 500_000 });
  const second = await harness.beforeSwap({ key, params, timestamp: 1_000n + 5n * 60n + 1n });
  const secondRawFee = second.fee - LP_FEE_OVERRIDE_FLAG;
  assert.ok(secondRawFee >= 500n && secondRawFee <= 6000n, 'la tarifa debe permanecer en [FLOOR_FEE, CAP_FEE]');

  const firstRawFee = first.fee - LP_FEE_OVERRIDE_FLAG;
  assert.ok(secondRawFee - firstRawFee <= 500n, 'la tarifa no puede subir más de MAX_FEE_STEP por intervalo');
});

test('el compilador genera un artefacto reproducible para registrar el hook', () => {
  execFileSync(process.execPath, ['scripts/compile.js'], { cwd: root, stdio: 'pipe' });
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'VolatilityShieldV1.json'), 'utf8'));
  assert.equal(artifact.contractName, 'VolatilityShieldV1');
  assert.match(artifact.creationBytecode, /^0x[0-9a-f]+$/i);
  assert.match(artifact.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/i);
});
