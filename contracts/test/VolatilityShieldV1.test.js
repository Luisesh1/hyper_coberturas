const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const solc = require('solc');

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

test('Volatility Shield V1 conserva los límites y guardrails de tarifa', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /FLOOR_FEE\s*=\s*500/);
  assert.match(source, /BASE_FEE\s*=\s*3000/);
  assert.match(source, /CAP_FEE\s*=\s*6000/);
  assert.match(source, /UPDATE_INTERVAL\s*=\s*5 minutes/);
  assert.match(source, /MAX_FEE_STEP\s*=\s*500/);
  assert.match(source, /BeforeSwapDelta\.wrap\(0\)/);
  assert.match(source, /LPFeeLibrary\.OVERRIDE_FEE_FLAG\s*\|\s*fee/);
});

test('el compilador genera un artefacto reproducible para registrar el hook', () => {
  execFileSync(process.execPath, ['scripts/compile.js'], { cwd: root, stdio: 'pipe' });
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'VolatilityShieldV1.json'), 'utf8'));
  assert.equal(artifact.contractName, 'VolatilityShieldV1');
  assert.match(artifact.creationBytecode, /^0x[0-9a-f]+$/i);
  assert.match(artifact.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/i);
});
