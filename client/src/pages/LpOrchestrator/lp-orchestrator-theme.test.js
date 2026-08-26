/**
 * Contrato de tema del orquestador LP.
 *
 * El bug que cubre este archivo: la cáscara de la página cambiaba a claro,
 * pero las tarjetas (`OrchestratorCard`), la barra de rango y los paneles de
 * contabilidad seguían pintando su fondo casi negro y su texto de tema
 * oscuro, porque esos colores estaban hardcodeados en cada `.module.css` en
 * lugar de venir de un token. El resultado era texto oscuro sobre superficie
 * oscura dentro de una página clara.
 *
 * La regla que se fija aquí es la que impide que vuelva: en esta página
 * NINGÚN color se escribe literal. Todo pasa por un token de `tokens.css`,
 * que es el único sitio donde vive la contraparte clara.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const PAGE_DIR = resolve(ROOT, 'src/pages/LpOrchestrator');
const TOKENS = readFileSync(resolve(ROOT, 'src/styles/tokens.css'), 'utf8');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(PAGE_DIR);
const cssFiles = files.filter((f) => f.endsWith('.module.css'));
const jsxFiles = files.filter((f) => f.endsWith('.jsx'));
const rel = (f) => relative(ROOT, f);

/** Quita comentarios: un hex citado en una explicación no pinta nada. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Tokens declarados en el bloque base y en el bloque de tema claro. */
function parseTheme(selector) {
  const start = TOKENS.indexOf(selector);
  const body = TOKENS.slice(start + selector.length);
  const block = body.slice(0, body.indexOf('\n}'));
  return Object.fromEntries(
    [...block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]),
  );
}

const darkTokens = parseTheme(':root {');
const lightTokens = parseTheme(":root[data-theme='light'] {");

/** Sólo los tokens de COLOR necesitan contraparte clara: radios, tipografía
 *  y espaciado son iguales en ambos temas a propósito. */
const isColorToken = (value) =>
  /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(value) || /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value);

describe('LpOrchestrator — contrato de tema', () => {
  it('hay hojas de estilo que revisar', () => {
    expect(cssFiles.length).toBeGreaterThan(4);
    expect(jsxFiles.length).toBeGreaterThan(4);
  });

  it('ningún .module.css escribe un color literal', () => {
    // `rgba(var(--uni-red-rgb), 0.12)` sí vale: el canal es un token y sólo
    // la opacidad queda en el componente. Lo que se prohíbe es el canal
    // literal (`rgba(255, 125, 125, …)`) y el hex suelto.
    const offenders = [];
    for (const file of cssFiles) {
      const src = stripComments(readFileSync(file, 'utf8'));
      src.split('\n').forEach((line, i) => {
        const hit = line.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[0-9]/);
        if (hit) offenders.push(`${rel(file)}:${i + 1} → ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('ningún .jsx pinta un color en un style inline', () => {
    const offenders = [];
    for (const file of jsxFiles) {
      const src = stripComments(readFileSync(file, 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[0-9]/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1} → ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('todo token usado existe y tiene contraparte en tema claro', () => {
    // Un `var(--token)` que no existe no falla en build: cae al valor
    // heredado o a nada, y sólo se nota mirando la página. Un token que
    // existe pero no está redefinido en claro es exactamente el bug.
    const unknown = new Set();
    const darkOnly = new Set();
    for (const file of [...cssFiles, ...jsxFiles]) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const [, name] of src.matchAll(/var\(--([\w-]+)/g)) {
        if (darkTokens[name] === undefined) unknown.add(name);
        else if (isColorToken(darkTokens[name]) && lightTokens[name] === undefined) darkOnly.add(name);
      }
    }
    expect([...unknown]).toEqual([]);
    expect([...darkOnly]).toEqual([]);
  });

  it('las superficies del orquestador salen de tokens, no de literales', () => {
    // Comprobación dirigida a las tres superficies que se veían negras sobre
    // la página clara, por si alguien las reintroduce con otro nombre.
    const surfaceOf = (file, selector) => {
      const src = readFileSync(resolve(PAGE_DIR, file), 'utf8');
      const block = src.slice(src.indexOf(selector));
      return block.slice(0, block.indexOf('}')).match(/background:\s*([^;]+);/)[1];
    };
    expect(surfaceOf('components/OrchestratorCard.module.css', '.card {'))
      .toBe('var(--uni-surface-card)');
    expect(surfaceOf('components/OrchestratorRangeBar.module.css', '.card {'))
      .toBe('var(--uni-surface-sunken)');
    expect(surfaceOf('components/OrchestratorRangeBar.module.css', '.track {'))
      .toBe('var(--uni-surface-track)');
    expect(surfaceOf('components/AccountingPanel.module.css', '.root {'))
      .toBe('var(--uni-wash-soft)');
    expect(surfaceOf('LpOrchestratorPage.module.css', '.summaryStrip {'))
      .toBe('var(--uni-surface-panel)');
  });
});
