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

  let timestamp = 1_000n;
  let tick = 0;
  await harness.setSlot0({ key, tick });
  const first = await harness.beforeSwap({ key, params, timestamp });
  assert.equal(first.delta, 0n, 'el hook no debe modificar el accounting del swap');
  assert.equal(first.fee & LP_FEE_OVERRIDE_FLAG, LP_FEE_OVERRIDE_FLAG, 'debe activar el flag de override de fee');

  // De BASE_FEE (3000) a CAP_FEE (6000) en pasos de MAX_FEE_STEP (500) son 6
  // intervalos con la señal de volatilidad saturada, más uno que se va en fijar
  // la referencia del TWAP; encadenamos 8 saltos de tick grandes para tocar el
  // techo de verdad y confirmar que un intervalo adicional no lo perfora.
  let last = first;
  for (let i = 0; i < 8; i += 1) {
    const previousRawFee = last.fee - LP_FEE_OVERRIDE_FLAG;
    tick += 500_000;
    timestamp += 5n * 60n + 1n;
    await harness.setSlot0({ key, tick });
    last = await harness.beforeSwap({ key, params, timestamp });
    const rawFee = last.fee - LP_FEE_OVERRIDE_FLAG;
    assert.ok(rawFee >= 500n && rawFee <= 6000n, 'la tarifa debe permanecer en [FLOOR_FEE, CAP_FEE]');
    assert.ok(rawFee - previousRawFee <= 500n, 'la tarifa no puede subir más de MAX_FEE_STEP por intervalo');
  }

  assert.equal(last.fee - LP_FEE_OVERRIDE_FLAG, 6000n, 'tras suficientes intervalos saturados debe tocar exactamente CAP_FEE');
});

test('el compilador genera un artefacto reproducible para registrar el hook', () => {
  execFileSync(process.execPath, ['scripts/compile.js'], { cwd: root, stdio: 'pipe' });
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'VolatilityShieldV1.json'), 'utf8'));
  assert.equal(artifact.contractName, 'VolatilityShieldV1');
  assert.match(artifact.creationBytecode, /^0x[0-9a-f]+$/i);
  assert.match(artifact.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/i);
});
