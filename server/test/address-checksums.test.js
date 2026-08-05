const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

/**
 * Una direccion escrita con mayusculas/minusculas que no cuadran con EIP-55 es
 * un 500 esperando al flujo que la toque: ethers la rechaza con
 * INVALID_ARGUMENT en cuanto la usa como argumento de un contrato, y el error
 * no dice de que constante salio.
 *
 * Caso real: el Universal Router de Arbitrum estaba mal capitalizado y ajustar
 * el rango de un LP v4 respondia "Error interno del servidor" en cuanto el plan
 * necesitaba un swap. Los bytes eran correctos; solo el casing estaba mal.
 */
const ROOTS = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', '..', 'client', 'src'),
];

function collectSourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectSourceFiles(full, acc);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test('toda direccion hardcodeada tiene checksum EIP-55 valido', () => {
  const offenders = [];

  for (const root of ROOTS) {
    for (const file of collectSourceFiles(root)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        for (const match of line.matchAll(/0x[0-9a-fA-F]{40}/g)) {
          const address = match[0];
          // Todo en minusculas o todo en mayusculas no lleva checksum: ethers
          // lo acepta tal cual, no hay nada que validar.
          if (address === address.toLowerCase() || address === address.toUpperCase()) continue;
          try {
            ethers.getAddress(address);
          } catch {
            const canonical = ethers.getAddress(address.toLowerCase());
            offenders.push(
              `${path.relative(path.join(__dirname, '..', '..'), file)}:${idx + 1}\n`
              + `    ${address}\n    deberia ser ${canonical}`
            );
          }
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Direcciones con checksum invalido (mismos bytes, capitalizacion mal):\n${offenders.join('\n')}`
  );
});
