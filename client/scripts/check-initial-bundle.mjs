// Falla si el chunk vendor-wallet (wagmi/viem/WalletConnect) vuelve a la carga inicial.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.html');
const html = readFileSync(indexPath, 'utf8');

if (html.includes('vendor-wallet')) {
  console.error('vendor-wallet en la carga inicial');
  process.exit(1);
}
console.log('OK: vendor-wallet no está en la carga inicial');
