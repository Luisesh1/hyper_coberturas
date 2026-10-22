const { test, expect } = require('@playwright/test');

// Alertas con dirección (alcista / bajista / neutral): selector en «General»,
// chip y filtro en la lista, vista previa de Telegram y «Usada por», en
// escritorio y en móvil (390 px), con /api mockeada.
// Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md (A)

const RULES = [{
  weight: 1,
  conditions: [{
    indicatorType: 'macd',
    indicatorParams: { fast: 12, slow: 26, signal: 9 },
    timeframe: '15m',
    operandSeries: 'macd',
    operator: 'cross_up',
    operand: { kind: 'series', indicatorType: 'macd', indicatorParams: { fast: 12, slow: 26, signal: 9 }, timeframe: '15m', operandSeries: 'signal' },
  }],
  joiners: [],
}];

const alert = (id, name, direction, assetList = ['BTCUSDT']) => ({
  id, name, direction, isActive: true, thresholdPercent: 70, cooldownSeconds: 900,
  telegramEnabled: true, datasource: 'binance', assetList, rules: RULES,
});

const ALERTS = [
  alert(1, 'BTC · MACD cruce alcista 15m', 'bullish'),
  alert(2, 'BTC · MACD cruce bajista 15m', 'bearish'),
  alert(3, 'ETH · RSI sobreventa', 'bullish', ['ETHUSDT']),
  alert(4, 'Volumen anómalo multi-activo', 'neutral', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
];

const BOTS = [
  { id: 70, name: 'Momentum BTC (MACD 15m)', mode: 'shadow', underlying: 'BTC', params: { alertIds: [1, 2], structure: 'buy_with' }, alerts: [{ id: 1 }, { id: 2 }] },
];

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
    if (pathname === '/api/options/auto-bots') return json(BOTS);
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

test.describe('Alertas con dirección en escritorio', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('filtro, chip, selector, vista previa y aviso al pasar a Neutral', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const { updates } = await mockApi(page);
    await page.goto('/alertas');

    const item = page.getByRole('button', { name: /BTC · MACD cruce alcista 15m/ });
    await expect(item).toContainText('Alcista');
    await expect(item).toContainText('Usada por 1 bot');

    const filters = page.getByRole('group', { name: 'Filtrar por dirección' });
    await filters.getByRole('button', { name: /Bajistas/ }).click();
    await expect(page.getByRole('button', { name: /BTC · MACD cruce bajista 15m/ })).toBeVisible();
    await expect(item).toHaveCount(0);
    await filters.getByRole('button', { name: 'Todas' }).click();

    await item.click();
    const selector = page.getByRole('radiogroup', { name: 'Dirección de la señal' });
    await expect(selector.getByRole('radio', { name: /Alcista/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('telegram-preview')).toContainText('🟢 ALCISTA · BTC · MACD cruce alcista 15m');
    await expect(page.getByTestId('used-by')).toContainText('Sombra · abre calls');
    await page.screenshot({ path: 'test-results/alerts-direction-desktop.png', fullPage: true });

    await selector.getByRole('radio', { name: /Neutral/ }).click();
    await expect(page.getByRole('alert')).toContainText('Si la pasas a Neutral, el bot dejará de operarla');
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => updates.length).toBe(1);
    expect(updates[0].direction).toBe('neutral');

    expect(await horizontalOverflow(page)).toBe(0);
    expect(errores).toEqual([]);
  });
});

test.describe('Alertas con dirección en móvil (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('lista → editor a pantalla completa con selector grande y CTA fijo', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    await mockApi(page);
    await page.goto('/alertas');

    await expect(page.getByRole('group', { name: 'Filtrar por dirección' })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/alerts-direction-mobile-list.png' });

    await page.getByRole('button', { name: /BTC · MACD cruce bajista 15m/ }).click();
    await expect(page.getByRole('heading', { name: 'Editar alerta' })).toBeVisible();
    const selector = page.getByRole('radiogroup', { name: 'Dirección de la señal' });
    const radios = selector.getByRole('radio');
    await expect(radios).toHaveCount(3);
    // Cuadrícula de 3 columnas: las tres opciones en una sola fila.
    const boxes = [];
    for (let i = 0; i < 3; i += 1) {
      const box = await radios.nth(i).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      boxes.push(box);
    }
    expect(Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y))).toBeLessThan(4);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    expect(await horizontalOverflow(page)).toBe(0);
    await expect(selector.getByRole('radio', { name: /Bajista/ })).toHaveAttribute('aria-checked', 'true');
    await selector.getByRole('radio', { name: /Alcista/ }).tap();
    // La vista previa de Telegram vive dentro de «Más opciones».
    await page.getByRole('button', { name: /^Más opciones/ }).tap();
    await expect(page.getByTestId('telegram-preview')).toContainText('🟢 ALCISTA');

    const cta = page.getByRole('button', { name: 'Guardar cambios' });
    const ctaBox = await cta.boundingBox();
    expect(ctaBox.height).toBeGreaterThanOrEqual(44);
    expect(ctaBox.y + ctaBox.height).toBeGreaterThan(844 - 60);
    expect(await horizontalOverflow(page)).toBe(0);
    await page.screenshot({ path: 'test-results/alerts-direction-mobile-editor.png' });

    await page.getByRole('button', { name: 'Volver a alertas' }).click();
    await expect(page.getByRole('button', { name: '+ Nueva alerta' })).toBeVisible();
    expect(errores).toEqual([]);
  });
});
