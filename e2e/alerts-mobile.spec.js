const { test, expect } = require('@playwright/test');

// Alertas en móvil (rediseño): lista de tarjetas con interruptor y «Probar»,
// editor a pantalla completa y hoja de regla, con /api mockeada.
// Spec: docs/superpowers/specs/2026-10-22-alerts-mobile-ux-design.md

const MACD = {
  indicatorType: 'macd',
  indicatorParams: { fast: 12, slow: 26, signal: 9 },
  timeframe: '15m',
  operandSeries: 'macd',
  operator: 'cross_up',
  operand: { kind: 'series', indicatorType: 'macd', indicatorParams: { fast: 12, slow: 26, signal: 9 }, timeframe: '15m', operandSeries: 'signal' },
};
const SQZ = {
  indicatorType: 'sqzmom',
  indicatorParams: { length: 20, mult: 2, lengthKC: 20, multKC: 1.5, useTrueRange: true },
  timeframe: '15m',
  operandSeries: 'sqzMomentum',
  operator: 'momentum_positive',
  operand: { kind: 'none' },
};
const RSI = {
  indicatorType: 'rsi',
  indicatorParams: { period: 14 },
  timeframe: '1h',
  operandSeries: 'rsi',
  operator: 'lt',
  operand: { kind: 'constant', value: 30 },
};

const SHORT_RULES = [{ weight: 1, conditions: [MACD], joiners: [] }];
// 5 reglas de 3 condiciones; la condición 1 de la regla 1 es Squeeze Momentum.
const LONG_RULES = Array.from({ length: 5 }, (_, r) => ({
  weight: 1 + r * 0.5,
  label: `Regla larga número ${r + 1} con una etiqueta bastante extensa para forzar el ajuste`,
  conditions: [r === 0 ? SQZ : MACD, RSI, MACD],
  joiners: ['and', r % 2 ? 'or' : 'and'],
}));
const ASSETS_22 = Array.from({ length: 22 }, (_, i) => `TOKEN${i + 1}USDT`);

const alert = (id, name, rules, assetList = ['BTCUSDT']) => ({
  id, name, direction: 'bullish', isActive: true, thresholdPercent: 70, cooldownSeconds: 900,
  telegramEnabled: true, datasource: 'binance', assetList, rules,
});

const ALERTS = [
  alert(1, 'BTC · MACD cruce alcista 15m', SHORT_RULES),
  alert(2, 'ETH · RSI sobreventa', SHORT_RULES, ['ETHUSDT']),
  alert(5, 'Alerta larga multi-activo con un nombre muy largo para comprobar el ajuste de línea', LONG_RULES, ASSETS_22),
];

const TEST_RESULT = {
  results: [{
    asset: 'BTCUSDT', lowestTimeframe: '15m', score: 82.5, threshold: 70, wouldTrigger: true,
    rules: [{ matched: true, rule: { label: 'MACD' }, reason: 'MACD cruza al alza' }],
  }],
};

async function mockApi(page) {
  const updates = [];
  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
    if (pathname === '/api/alerts' && method === 'GET') return json(ALERTS);
    const m = pathname.match(/^\/api\/alerts\/(\d+)$/);
    if (m && method === 'PUT') {
      const body = route.request().postDataJSON();
      updates.push(body);
      return json({ id: Number(m[1]), ...body });
    }
    if (/^\/api\/alerts\/\d+\/test$/.test(pathname) && method === 'POST') return json(TEST_RESULT);
    if (pathname === '/api/options/auto-bots') return json([]);
    // Fallback en array: varios consumidores globales hacen `.reduce`.
    return json([]);
  });
  return { updates };
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

async function scenario(page, { light = false } = {}) {
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));
  const { updates } = await mockApi(page);
  await page.goto('/alertas');
  if (light) {
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.style.colorScheme = 'light';
    });
  }

  // Lista: sin scroll horizontal e interruptor.
  await expect(page.getByRole('button', { name: '+ Nueva alerta' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  const sw = page.getByRole('switch', { name: 'BTC · MACD cruce alcista 15m: Activa' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0].isActive).toBe(false);

  // «Probar» abre la hoja con el resultado.
  await page.getByRole('button', { name: 'Probar' }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('82.5% / 70%');
  expect(await horizontalOverflow(page)).toBe(0);
  // La hoja es oscura en los dos temas: su contenido va en claro.
  const noteColor = await sheet.getByText('Prueba sin enviar a Telegram.').evaluate((el) => getComputedStyle(el).color);
  expect(noteColor).toBe('rgb(182, 190, 201)');
  await sheet.getByRole('button', { name: 'Listo' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Alerta larga: sin scroll horizontal.
  await page.getByRole('button', { name: /Alerta larga multi-activo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Editar alerta' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);

  // Regla 1: temporalidad 4h y operador «momentum subiendo».
  await page.getByRole('button', { name: /^Regla 1/ }).click();
  const rule = page.getByRole('dialog', { name: 'Regla 1' });
  await expect(rule).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  await rule.getByRole('button', { name: '4h', exact: true }).first().click();
  await rule.getByRole('combobox', { name: 'Condición', exact: true }).first().selectOption({ label: 'momentum subiendo ↗' });
  await rule.getByRole('button', { name: 'Aplicar regla' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const card = page.getByRole('button', { name: /^Regla 1/ });
  await expect(card).toContainText('4h');
  await expect(card).toContainText('momentum subiendo');
  expect(await horizontalOverflow(page)).toBe(0);

  // «⋯» ofrece «Probar y enviar Telegram» (deshabilitado con cambios).
  await page.getByRole('button', { name: 'Más acciones' }).click();
  const menu = page.getByRole('dialog', { name: 'Acciones' });
  await expect(menu.getByRole('button', { name: 'Probar y enviar Telegram' })).toBeDisabled();
  await menu.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect.poll(() => updates.length).toBe(2);
  const first = updates[1].rules[0].conditions[0];
  expect(first.timeframe).toBe('4h');
  expect(first.operator).toBe('momentum_rising');
  expect(errores).toEqual([]);
}

test.describe('Alertas en móvil', () => {
  test.use({ hasTouch: true });

  test('360×740: lista, probar, alerta larga y edición de regla', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await scenario(page);
  });

  test('390×844: lista, probar, alerta larga y edición de regla', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await scenario(page);
  });

  test('390×844 en tema claro: sin errores de página', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await scenario(page, { light: true });
  });
});

test.describe('Alertas en móvil · barra fija', () => {
  test.use({ hasTouch: true });

  test('360×740: con el aviso de validación, la barra no tapa el final del contenido', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockApi(page);
    await page.goto('/alertas');
    await page.getByRole('button', { name: '+ Nueva alerta' }).click();
    const bar = page.locator('[class*="mobileCtaBar"]');
    await expect(bar.locator('[class*="barError"]')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const add = page.getByRole('button', { name: '+ Añadir regla' });
    await expect(add).toBeVisible();
    const addBox = await add.boundingBox();
    const barBox = await bar.boundingBox();
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(barBox.y);
  });
});

test.describe('Alertas en escritorio (1440)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('el editor de escritorio no usa componentes móviles', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/alertas');
    await page.getByRole('button', { name: /BTC · MACD cruce alcista 15m/ }).first().click();
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a alertas' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bajar umbral' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Regla 1/ })).toHaveCount(0);
    expect(errores).toEqual([]);
  });
});
