import { execFileSync } from 'node:child_process';

/**
 * `npm audit --audit-level=high` con una lista corta de avisos aceptados.
 *
 * npm audit no permite ignorar un aviso concreto: o se baja el nivel para
 * todo el paquete o el CI queda rojo hasta que el upstream publique arreglo.
 * Este script ejecuta el audit, descarta solo los GHSA listados abajo y falla
 * con cualquier otro aviso alto o crítico, incluidos los que lleguen nuevos.
 *
 * Uso: node scripts/audit-with-exceptions.mjs <carpeta-del-paquete>
 *
 * Cada excepción lleva el motivo y la condición para quitarla. Revisarlas
 * cuando cambien las dependencias afectadas.
 */

const EXCEPTIONS = {
  client: {
    // zod < 4.6.6: agotamiento de memoria al validar colecciones enormes.
    // Solo llega al cliente vía las librerías de wallet (WalletConnect/Reown,
    // wagmi, abitype), que exigen zod 3 y corren en el navegador del propio
    // usuario. No hay 3.x parcheado y el arreglo automático degrada
    // WalletConnect. El zod del servidor (validación de la API) sí está en
    // 4.6.6. Quitar cuando @walletconnect/ethereum-provider dependa de
    // zod >= 4.6.6. Aceptado por el usuario el 2026-10-24.
    'GHSA-mrhx-c7xc-m3w5': 'zod < 4.6.6 en dependencias de wallet del navegador',
  },
};

const BLOCKING = new Set(['high', 'critical']);

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('Uso: node scripts/audit-with-exceptions.mjs <carpeta-del-paquete>');
  process.exit(2);
}
const allowed = EXCEPTIONS[pkgDir] || {};

let raw;
try {
  raw = execFileSync('npm', ['--prefix', pkgDir, 'audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit sale con código 1 cuando hay avisos; el JSON viene igual en stdout.
  raw = err.stdout;
  if (!raw) throw err;
}
const report = JSON.parse(raw);
if (report.error) {
  console.error(`npm audit falló en ${pkgDir}:`, report.error.summary || report.error);
  process.exit(1);
}

// Solo cuentan los avisos de origen (entradas `via` con URL). Un paquete que
// solo hereda el aviso de una dependencia queda cubierto por ese aviso.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities || {})) {
  for (const via of vuln.via) {
    if (typeof via !== 'object' || !via.url) continue;
    const id = via.url.split('/').pop();
    advisories.set(id, { id, severity: via.severity, name: via.name, title: via.title });
  }
}

const blocking = [...advisories.values()].filter((a) => BLOCKING.has(a.severity) && !allowed[a.id]);
const accepted = [...advisories.values()].filter((a) => allowed[a.id]);

for (const a of accepted) console.log(`Aceptado ${a.id} (${a.name}): ${allowed[a.id]}`);
for (const id of Object.keys(allowed)) {
  if (!advisories.has(id)) console.log(`Aviso: la excepción ${id} ya no aparece en el audit; se puede quitar.`);
}

if (blocking.length) {
  console.error(`Avisos ${[...BLOCKING].join('/')} sin excepción en ${pkgDir}:`);
  for (const a of blocking) console.error(`  ${a.severity} ${a.id} ${a.name}: ${a.title}`);
  process.exit(1);
}
console.log(`npm audit (${pkgDir}): sin avisos altos o críticos fuera de las excepciones.`);
