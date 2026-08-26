/**
 * Catalogo de contratos desplegables desde el panel.
 *
 * Los `.json` de esta carpeta son copias generadas de `contracts/artifacts/`
 * (ver `npm run sync:artifacts`). No se editan a mano: `npm run check` falla
 * si dejan de coincidir con el artefacto original.
 */
const fs = require('node:fs');
const path = require('node:path');

function loadCatalog() {
  return fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')));
}

const CATALOG = loadCatalog();

function listCatalog() {
  return CATALOG;
}

function getCatalogEntry(name) {
  return CATALOG.find((entry) => entry.contractName === name) || null;
}

module.exports = { listCatalog, getCatalogEntry };
