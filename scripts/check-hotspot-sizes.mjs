import fs from 'node:fs';
import path from 'node:path';

/**
 * Trinquete de tamaño para los archivos que ya sabemos que están de más.
 *
 * Antes esto eran presupuestos absolutos escritos a mano. El problema no era
 * el mecanismo sino el mantenimiento: en cuanto tres archivos superaron su
 * número, el check pasó a fallar siempre y dejó de significar nada — ni
 * avisaba de crecimientos nuevos ni bloqueaba nada, porque ya estaba rojo.
 *
 * El baseline commiteado invierte la regla: no importa cuánto pesa un archivo,
 * importa que no pese más que la última vez que lo miramos. Encoger es libre y
 * `--update` baja el listón; crecer falla y obliga a justificar el `--update`
 * en la revisión del PR, que es exactamente donde queremos la conversación.
 */

const repoRoot = process.cwd();
const baselinePath = path.join(repoRoot, 'scripts/hotspot-baseline.json');
const shouldUpdate = process.argv.includes('--update');

const formatKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

if (!fs.existsSync(baselinePath)) {
  console.error(`No existe ${path.relative(repoRoot, baselinePath)}. Genéralo con: npm run check:hotspots -- --update`);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const tracked = Object.keys(baseline.files).sort();

const violations = [];
const shrunk = [];
const nextSizes = {};

for (const file of tracked) {
  const absolutePath = path.join(repoRoot, file);
  if (!fs.existsSync(absolutePath)) {
    // Un hotspot que desaparece casi siempre es un split terminado. Se avisa
    // para que `--update` lo retire del baseline, pero no se falla por ello.
    shrunk.push(`${file}: ya no existe (¿se partió? quítalo con --update)`);
    continue;
  }

  const size = fs.statSync(absolutePath).size;
  const limit = baseline.files[file];
  nextSizes[file] = size;

  if (size > limit) {
    violations.push(
      `${file}: ${formatKb(size)} crece sobre el baseline de ${formatKb(limit)} (+${formatKb(size - limit)})`
    );
  } else if (size < limit) {
    shrunk.push(`${file}: ${formatKb(size)} baja del baseline de ${formatKb(limit)} (−${formatKb(limit - size)})`);
  }
}

if (shouldUpdate) {
  const updated = { ...baseline, updatedAt: new Date().toISOString().slice(0, 10), files: {} };
  for (const file of tracked) {
    if (nextSizes[file] != null) updated.files[file] = nextSizes[file];
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Baseline actualizado con ${Object.keys(updated.files).length} archivos.`);
  process.exit(0);
}

if (shrunk.length) {
  console.log('Hotspots que encogieron (baja el baseline con --update):');
  for (const line of shrunk) console.log(`- ${line}`);
}

if (violations.length) {
  console.error('Hotspot size check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error('\nParte el archivo, o justifica el crecimiento y corre: npm run check:hotspots -- --update');
  process.exit(1);
}

console.log(`Hotspot size check passed (${tracked.length} archivos vigilados).`);
