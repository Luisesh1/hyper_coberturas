/**
 * Copia los artefactos compilados de `contracts/` al servidor.
 *
 * Hace falta porque el contenedor del servidor solo monta `./server:/app`:
 * desde ahi no existe ninguna ruta relativa que llegue a `contracts/`.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'contracts', 'artifacts');
const to = join(root, 'server', 'src', 'contracts', 'catalog');

mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((name) => name.endsWith('.json'));
if (files.length === 0) {
  throw new Error('No hay artefactos que sincronizar: ejecuta antes `npm --prefix contracts run compile`.');
}
for (const name of files) {
  writeFileSync(join(to, name), readFileSync(join(from, name)));
  console.log(`sincronizado ${name}`);
}
