import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const budgets = [
  { file: 'server/src/services/uniswap-position-actions.service.js', maxBytes: 130000 },
  { file: 'server/src/services/uniswap.service.js', maxBytes: 70000 },
  { file: 'server/src/services/protected-pool-delta-neutral.service.js', maxBytes: 70000 },
  { file: 'server/src/services/uniswap-protection.service.js', maxBytes: 70000 },
  { file: 'server/src/services/hedge.service.js', maxBytes: 55000 },
  { file: 'server/src/services/smart-pool-creator.service.js', maxBytes: 55000 },
  { file: 'client/src/pages/UniswapPools/components/SmartCreatePoolModal.jsx', maxBytes: 55000 },
  { file: 'client/src/pages/UniswapPools/components/PositionActionModal.jsx', maxBytes: 40000 },
  { file: 'client/src/pages/UniswapPools/components/ApplyProtectionModal.jsx', maxBytes: 40000 },
  { file: 'client/src/pages/UniswapPools/UniswapPoolsPage.jsx', maxBytes: 28000 },
  { file: 'client/src/pages/UniswapPools/components/ProtectedPoolCard.jsx', maxBytes: 26000 },
  { file: 'client/src/pages/UniswapPools/components/PoolCard.jsx', maxBytes: 20000 },
  { file: 'client/src/hooks/useWalletConnection.js', maxBytes: 20000 },
];

const formatKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const violations = [];

for (const budget of budgets) {
  const absolutePath = path.join(repoRoot, budget.file);
  if (!fs.existsSync(absolutePath)) {
    violations.push(`${budget.file}: archivo no encontrado`);
    continue;
  }

  const size = fs.statSync(absolutePath).size;
  if (size > budget.maxBytes) {
    violations.push(
      `${budget.file}: ${formatKb(size)} supera el presupuesto de ${formatKb(budget.maxBytes)}`
    );
  }
}

if (violations.length) {
  console.error('Hotspot size check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Hotspot size check passed.');
