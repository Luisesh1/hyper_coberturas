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

/** Triple de canales suelto (`102, 225, 219`) para los tokens `--*-rgb`. */
const isChannels = (value) => /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value);

/** ¿El valor lleva color dentro? Cubre hex, rgb/rgba, gradientes y sombras. */
const hasColor = (value) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(value) || isChannels(value);

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

  // ── Canales RGB (`--uni-X-rgb`) ────────────────────────────────
  // Las superficies del orquestador LP tiñen fondo/borde/sombra con el mismo
  // acento a una docena de opacidades. En vez de un token por opacidad se
  // expone el canal y el componente pone el alfa. Eso sólo es seguro si el
  // canal y su hex hermano no se separan nunca.
  const channelTokens = Object.keys(dark).filter((name) => name.endsWith('-rgb'));

  it('los tokens de canal existen y tienen hex hermano', () => {
    expect(channelTokens.length).toBeGreaterThan(0);
    const orphans = channelTokens.filter((name) => dark[name.replace(/-rgb$/, '')] === undefined);
    expect(orphans).toEqual([]);
  });

  it('cada canal coincide con su hex hermano en AMBOS temas', () => {
    const toChannels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const mismatches = [];
    for (const theme of ['dark', 'light']) {
      const tokens = theme === 'dark' ? dark : { ...dark, ...light };
      for (const name of channelTokens) {
        const expected = toChannels(tokens[name.replace(/-rgb$/, '')]);
        const actual = tokens[name].replace(/\s+/g, ' ');
        if (actual !== expected) mismatches.push(`${theme}/${name}: ${actual} ≠ ${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // ── Paleta LP (`--uni-*`) ──────────────────────────────────────
  const UNI_FOREGROUNDS = [
    'uni-text-0', 'uni-text-1', 'uni-text-2', 'uni-text-3',
    'uni-cyan', 'uni-blue', 'uni-green', 'uni-amber', 'uni-orange', 'uni-red', 'uni-violet',
    'uni-blue-pastel',
  ];

  it('los acentos LP cumplen AA (4.5:1) sobre la superficie de tarjeta clara', () => {
    const tokens = { ...dark, ...light };
    const failures = UNI_FOREGROUNDS
      .map((fg) => [fg, contrast(tokens[fg], tokens['uni-bg-1'])])
      .filter(([, ratio]) => ratio < 4.5)
      .map(([fg, ratio]) => `${fg} ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it('el texto sobre acento sólido contrasta con ámbar, cian y rojo', () => {
    // --uni-on-accent va encima de un relleno del acento (badge del contador,
    // icono del chip de incidencia). Si se invierte mal, el badge se lee peor
    // en claro que en oscuro, que es el defecto que se está corrigiendo.
    for (const theme of ['dark', 'light']) {
      const tokens = theme === 'dark' ? dark : { ...dark, ...light };
      for (const accent of ['uni-amber', 'uni-cyan', 'uni-red']) {
        expect(
          contrast(tokens['uni-on-accent'], tokens[accent]),
          `${theme}: --uni-on-accent sobre --${accent}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('las superficies LP se invierten: oscuras en oscuro, claras en claro', () => {
    // Es la regresión concreta del bug: la tarjeta del orquestador seguía
    // pintando su degradado casi negro con el resto de la página ya en claro.
    const SURFACES = [
      'uni-surface-card', 'uni-surface-panel', 'uni-surface-panel-soft',
      'uni-surface-sunken', 'uni-surface-track',
      // El aro del marker recorta sobre la pista: sigue a la superficie, no al velo.
      'uni-marker-ring',
    ];
    for (const name of SURFACES) {
      expect(dark[name], `falta --${name} en oscuro`).toBeDefined();
      expect(light[name], `falta --${name} en claro`).toBeDefined();
      // Media de los canales de todos los colores del valor: sirve igual para
      // un rgba suelto que para un degradado con dos paradas.
      const brightness = (value) => {
        const nums = [...value.matchAll(/#([0-9a-fA-F]{6})|rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)]
          .map((m) => (m[1] ? [1, 3, 5].map((i) => parseInt(m[1].slice(i - 1, i + 1), 16)) : [+m[2], +m[3], +m[4]]))
          .flat();
        expect(nums.length, `--${name} no tiene colores parseables`).toBeGreaterThan(0);
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      };
      expect(brightness(dark[name]), `--${name} (oscuro)`).toBeLessThan(90);
      expect(brightness(light[name]), `--${name} (claro)`).toBeGreaterThan(200);
    }
  });

  it('los velos de realce se invierten (aclarar en oscuro, oscurecer en claro)', () => {
    for (const name of ['uni-wash-soft', 'uni-wash', 'uni-wash-strong', 'uni-track-hatch']) {
      const [, dr] = dark[name].match(/rgba?\(\s*(\d+)/);
      const [, lr] = light[name].match(/rgba?\(\s*(\d+)/);
      expect(Number(dr), `--${name} debería aclarar en oscuro`).toBeGreaterThan(200);
      expect(Number(lr), `--${name} debería oscurecer en claro`).toBeLessThan(60);
    }
  });

  it('el texto secundario cumple al menos AA-large (3:1) en ambos temas', () => {
    for (const theme of ['dark', 'light']) {
      const tokens = theme === 'dark' ? dark : { ...dark, ...light };
      expect(contrast(tokens['text-tertiary'], tokens['bg-card'])).toBeGreaterThanOrEqual(3);
    }
  });
});
