import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const jsFiles = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) {
      jsFiles.push(absolute);
    }
  }
}

walk(path.join(repoRoot, 'server/src'));
walk(path.join(repoRoot, 'client/src'));

function readImports(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const matches = source.matchAll(/(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g);
  return Array.from(matches, (match) => match[1] || match[2]).filter(Boolean);
}

function relativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
}

const violations = [];

for (const filePath of jsFiles) {
  const relPath = relativeRepoPath(filePath);
  const imports = readImports(filePath);

  if (relPath.startsWith('server/src/domains/') && relPath.includes('/domain/')) {
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = relativeRepoPath(path.resolve(path.dirname(filePath), specifier));
      if (
        resolved.includes('/application/')
        || resolved.includes('/infrastructure/')
        || resolved.includes('/interface/')
        || resolved.includes('/routes/')
        || resolved.includes('/middleware/')
        || resolved.includes('/services/')
      ) {
        violations.push(`${relPath}: el dominio no debe importar ${resolved}`);
      }
    }
  }

  if (relPath.startsWith('server/src/shared/')) {
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = relativeRepoPath(path.resolve(path.dirname(filePath), specifier));
      if (resolved.startsWith('server/src/domains/')) {
        violations.push(`${relPath}: shared no debe depender de dominios (${resolved})`);
      }
    }
  }

  if (relPath.startsWith('client/src/shared/')) {
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = relativeRepoPath(path.resolve(path.dirname(filePath), specifier));
      if (resolved.startsWith('client/src/features/')) {
        violations.push(`${relPath}: shared no debe depender de features (${resolved})`);
      }
    }
  }
}

if (violations.length) {
  console.error('Architecture boundary check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Architecture boundary check passed.');
