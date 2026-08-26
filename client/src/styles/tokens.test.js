/**
 * Contrato del sistema de tokens.
 *
 * El modo claro sólo funciona si TODO color vive en un token y ese token
 * tiene contraparte en `[data-theme='light']`. Este test es la red que
 * avisa cuando alguien añade un color nuevo y se olvida del tema claro;
 * si no, la regresión sólo se ve abriendo la app en claro.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// El entorno jsdom sirve `import.meta.url` como http://, así que no vale para
// resolver rutas. Vitest fija cwd en la raíz del proyecto (client/).
const CSS = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** Extrae `--token: valor;` de un bloque de declaraciones. */
function parseTokens(block) {
  const tokens = {};
  for (const match of block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function blockAfter(selector) {
  const start = CSS.indexOf(selector);
  expect(start, `no se encontró el selector ${selector}`).toBeGreaterThan(-1);
  const body = CSS.slice(start + selector.length);
  return body.slice(0, body.indexOf('\n}'));
}

// El primer `:root {` es el bloque base (tema oscuro).
const dark = parseTokens(blockAfter(':root {'));
const light = parseTokens(blockAfter(":root[data-theme='light'] {"));

/** ¿El valor lleva color dentro? Cubre hex, rgb/rgba, gradientes y sombras. */
const hasColor = (value) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(value);

// ── Contraste (WCAG 2.2, fórmula de luminancia relativa) ───────────
const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Tokens que la UI usa mayoritariamente como color de texto. */
const FOREGROUNDS = [
  'text-bright', 'text-primary', 'text-muted', 'text-secondary',
  'green', 'red', 'amber', 'blue', 'indigo', 'teal', 'cyan', 'orange',
  'status-ok', 'status-warn', 'status-error', 'status-idle', 'status-info',
];

describe('tokens.css — contrato de temas', () => {
  it('el tema oscuro es el default: no hay data-theme en el bloque base', () => {
    expect(dark['bg-primary']).toBe('#0f1117');
    expect(dark['text-primary']).toBe('#e2e8f0');
    expect(CSS.indexOf(':root {')).toBeLessThan(CSS.indexOf("data-theme='light'"));
  });

  it('cada token de color del tema oscuro tiene contraparte en claro', () => {
    const missing = Object.entries(dark)
      .filter(([name, value]) => hasColor(value) && light[name] === undefined)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('el tema claro no inventa tokens que no existan en el base', () => {
    const orphans = Object.keys(light).filter((name) => dark[name] === undefined);
    expect(orphans).toEqual([]);
  });

  it('el tema claro no redefine tokens que no son de color', () => {
    // Radios, tipografía, espaciado y z-index deben ser idénticos en ambos
    // temas: si aparecen aquí es que se duplicó algo por error.
    const nonColor = Object.keys(light).filter(
      (name) => name !== 'color-scheme' && !hasColor(dark[name]),
    );
    expect(nonColor).toEqual([]);
  });

  it('el tema claro invierte la rampa de texto', () => {
    const ramp = ['text-bright', 'text-primary', 'text-muted', 'text-secondary', 'text-tertiary', 'text-hint', 'text-disabled'];
    const darkLums = ramp.map((t) => luminance(dark[t]));
    const lightLums = ramp.map((t) => luminance(light[t]));

    // En oscuro el texto se va apagando (más oscuro); en claro, aclarando.
    for (let i = 1; i < ramp.length; i++) {
      expect(darkLums[i], `${ramp[i]} debería ser más oscuro que ${ramp[i - 1]}`).toBeLessThan(darkLums[i - 1]);
      expect(lightLums[i], `${ramp[i]} debería ser más claro que ${ramp[i - 1]}`).toBeGreaterThan(lightLums[i - 1]);
    }
  });

  it('el texto principal y los acentos del tema claro cumplen AA (4.5:1)', () => {
    const tokens = { ...dark, ...light };
    const failures = FOREGROUNDS
      .map((fg) => [fg, contrast(tokens[fg], tokens['bg-card'])])
      .filter(([, ratio]) => ratio < 4.5)
      .map(([fg, ratio]) => `${fg} ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it('el tema oscuro no empeora su contraste actual', () => {
    // El tema oscuro es previo a este sistema y arrastra dos acentos que se
    // quedan algo por debajo de AA usados como texto sobre --bg-card:
    //   --red    4.49:1   --indigo  3.78:1
    // Corregirlos cambiaría la apariencia por defecto, así que quedan fuera
    // del alcance del modo claro. Este test sólo fija el suelo para que no
    // se degraden más, y deja el dato a la vista en lugar de esconderlo.
    const LEGACY = { red: 4.4, indigo: 3.7 };
    const failures = FOREGROUNDS
      .map((fg) => [fg, contrast(dark[fg], dark['bg-card'])])
      .filter(([fg, ratio]) => ratio < (LEGACY[fg] ?? 4.5))
      .map(([fg, ratio]) => `${fg} ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it('el texto secundario cumple al menos AA-large (3:1) en ambos temas', () => {
    for (const theme of ['dark', 'light']) {
      const tokens = theme === 'dark' ? dark : { ...dark, ...light };
      expect(contrast(tokens['text-tertiary'], tokens['bg-card'])).toBeGreaterThanOrEqual(3);
    }
  });
});
