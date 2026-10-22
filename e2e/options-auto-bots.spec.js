const { test, expect } = require('@playwright/test');

// Trading automatizado · «Probar señal»: crear un bot en sombra, simular una
// señal alcista, ver la fila «Simulada» y la posición abierta, y cerrarla con
// «Cerrar todo» (motivo «Manual»). /api mockeada con estado en memoria.
// Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md

const SPOT = 68000;
const SYMBOL = 'BTC-261031-70000-C';
const ALERT_UP = { id: 11, name: 'BTC · MACD cruce alcista 15m', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 };
const ALERT_DOWN = { id: 12, name: 'BTC · MACD cruce bajista 15m', direction: 'bearish', assetList: ['BTCUSDT'], thresholdPercent: 70 };

function createServerState() {
  const state = { bot: null, signals: [], positions: [], simulateCalls: [], closeCalls: [] };
  state.detail = () => ({
    ...state.bot,
    alerts: undefined,
    kpis: { shadow: { pnl30dUsdt: 0, cycles: 0, winRatePct: null }, live: {} },
    usage: {},
    events: [],
    positions: state.positions.filter((p) => p.closedAt == null),
    closedPositions: state.positions.filter((p) => p.closedAt != null),
  });
  return state;
}

async function mockApi(page, state) {
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

    if (pathname === '/api/options/underlyings') return json([{ underlying: 'BTC', spot: SPOT, change24hPct: 1.84 }]);
    if (pathname === '/api/options/auto-bots/eligible-alerts') return json([ALERT_UP, ALERT_DOWN]);
    if (pathname === '/api/options/auto-bots' && method === 'POST') {
      const body = route.request().postDataJSON();
      state.bot = {
        id: 7, template: 'alert_signal', mode: 'shadow', status: 'Sin posición', limits: {}, alerts: [ALERT_UP, ALERT_DOWN], pnl30d: { shadow: 0, live: null }, lastSignal: null,
        ...body, params: { ...body.params, alertIds: body.alertIds },
      };
      return json(state.bot, 201);
    }
    if (pathname === '/api/options/auto-bots') return json(state.bot ? [state.bot] : []);
    if (pathname === '/api/options/auto-bots/7/signals') return json([...state.signals].reverse());
    if (pathname === '/api/options/auto-bots/7/simulate' && method === 'POST') {
      const body = route.request().postDataJSON();
      state.simulateCalls.push(body);
      const now = Date.now();
      state.signals.push({
        id: state.signals.length + 1, alertId: null, alertName: 'Simulación', direction: body.direction, asset: 'BTC', score: null,
        decision: 'opened', detail: `Sombra: Compra ${SYMBOL} a 905`, simulated: true, createdAt: now,
      });
      state.positions.push({
        id: 31, mode: 'shadow', symbol: SYMBOL, side: 'BUY', quantity: 0.05, entryPrice: 905, mark: 920, openedAt: now, closedAt: null,
      });
      return json({ decision: 'opened', detail: `Sombra: Compra ${SYMBOL} a 905` });
    }
    if (pathname === '/api/options/auto-bots/7/close' && method === 'POST') {
      const body = route.request().postDataJSON();
      state.closeCalls.push(body);
      const now = Date.now();
      state.positions = state.positions.map((p) => (p.closedAt == null
        ? { ...p, closedAt: now, exitPrice: 920, pnlUsdt: 0.75, closeReason: 'manual' }
        : p));
      return json({ status: 'closed', detail: 'Cierre manual' });
    }
    if (pathname === '/api/options/strategies/7') return json(state.detail());
    // Fallback en array: varios consumidores globales hacen `.reduce`.
    return json([]);
  });
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

async function createShadowBot(page, state) {
  await page.getByRole('button', { name: 'Nuevo bot' }).click();
  const form = page.getByRole('dialog', { name: 'Nuevo bot' });
  await form.getByLabel('Nombre').fill('Bot de prueba');
  await form.getByRole('checkbox', { name: new RegExp(ALERT_UP.name) }).check();
  await form.getByRole('button', { name: 'Crear bot' }).click();
  await expect(form).toBeHidden();
  expect(state.bot.mode).toBe('shadow');
}

// Probar señal › Alcista → fila «Simulada» y posición abierta → Cerrar todo
// → confirmación → pasa a «Operaciones cerradas» con motivo «Manual».
async function simulateAndClose(page, state, scope) {
  await scope.getByRole('button', { name: /Probar señal/ }).click();
  await scope.getByRole('menuitem', { name: 'Alcista' }).click();
  await expect.poll(() => state.simulateCalls).toEqual([{ direction: 'bullish' }]);

  await expect(scope.getByText('Simulada').first()).toBeVisible();
  await expect(scope.getByText(SYMBOL).first()).toBeVisible();
  await expect(scope.getByText('Todavía no hay operaciones cerradas.')).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);

  await scope.getByRole('button', { name: 'Cerrar todo' }).click();
  const confirm = page.getByRole('dialog', { name: 'Cerrar todas las posiciones' });
  await expect(confirm).toBeVisible();
  expect(state.closeCalls).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Confirmar cierre' }).click();
  await expect(confirm.getByRole('status')).toContainText('Cerrado');
  await confirm.getByRole('button', { name: 'Listo' }).click();

  await expect(scope.getByText('Todavía no hay operaciones cerradas.')).toBeHidden();
  await expect(scope.getByText('Sin posiciones abiertas')).toBeVisible();
  const closed = scope.getByRole('region', { name: 'Operaciones cerradas' });
  await expect(closed.or(scope.locator('section', { hasText: 'Operaciones cerradas' })).first()).toContainText('Manual');
  expect(await horizontalOverflow(page)).toBe(0);
}

test.describe('Probar señal · escritorio', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('bot en sombra → Probar señal › Alcista → posición abierta → Cerrar todo', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const state = createServerState();
    await mockApi(page, state);
    await page.goto('/opciones?tab=auto');
    await createShadowBot(page, state);
    await expect(page.getByRole('heading', { name: 'Bot de prueba' })).toBeVisible();

    await simulateAndClose(page, state, page.getByRole('region', { name: 'Detalle del bot' }));
    await page.screenshot({ path: 'test-results/options-auto-simulate-desktop.png' });
    expect(errores).toEqual([]);
  });
});

test.describe('Probar señal · móvil (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('bot en sombra → Probar señal › Alcista → posición abierta → Cerrar todo', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));
    const state = createServerState();
    await mockApi(page, state);
    await page.goto('/opciones?tab=auto');
    await createShadowBot(page, state);

    const detail = page.getByRole('dialog', { name: 'Bot de prueba' });
    await expect(detail).toBeVisible();
    const trigger = detail.getByRole('button', { name: /Probar señal/ });
    expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await simulateAndClose(page, state, detail);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: 'test-results/options-auto-simulate-mobile.png' });
    expect(errores).toEqual([]);
  });
});
