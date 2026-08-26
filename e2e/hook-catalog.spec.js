const { test, expect } = require('@playwright/test');

const PREDICTED_ADDRESS = '0x0bbA77640ac3570bf1c3D221c81b0f067C39c080';

function catalogEntry(status) {
  return {
    contractName: 'VolatilityShieldV1',
    version: '1.0.0',
    network: 'base-sepolia',
    permissions: ['beforeSwap'],
    isMainnet: false,
    predictedAddress: PREDICTED_ADDRESS,
    status,
  };
}

/**
 * Intercepta la API y devuelve el registro de llamadas a `adopt`, para poder
 * afirmar que el camino sin gas no firma nada.
 */
async function mockApi(page, { status }) {
  const adoptCalls = [];

  await page.addInitScript(() => {
    localStorage.setItem('hl_token', 'test-token');
    localStorage.setItem('hl_user', JSON.stringify({
      id: 1, userId: 1, username: 'admin', name: 'Administrador', role: 'superuser',
    }));
  });

  // Contra el dev-server de Vite hay que filtrar por `pathname` exacto: el glob
  // `**/api/**` tambien captura modulos fuente como `/src/shared/api/httpClient.js`
  // y se los sirve como JSON, con lo que la aplicacion ni siquiera arranca.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();
    const json = (data) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });

    if (pathname === '/api/smart-contracts/catalog' && method === 'GET') {
      return json([catalogEntry(status)]);
    }
    if (pathname === '/api/smart-contracts/catalog/VolatilityShieldV1/adopt' && method === 'POST') {
      adoptCalls.push(route.request().postDataJSON());
      return json({ versionId: 1, address: PREDICTED_ADDRESS, status: 'registered' });
    }
    if (pathname === '/api/smart-contracts/catalog/VolatilityShieldV1/plan' && method === 'POST') {
      throw new Error('El camino sin gas no debe pedir un plan de despliegue');
    }
    if (pathname === '/api/smart-contracts' && method === 'GET') return json([]);
    return json([]);
  });

  return adoptCalls;
}

test('el catálogo registra sin gas un hook que ya está en cadena', async ({ page }) => {
  const adoptCalls = await mockApi(page, { status: 'deployed' });

  await page.goto('/contratos');

  await expect(page.getByText(/Ya está en esta red/i)).toBeVisible();
  await expect(page.getByText(PREDICTED_ADDRESS)).toBeVisible();

  const boton = page.getByRole('button', { name: /Registrarlo sin gastar gas/i });
  await expect(boton).toBeVisible();
  await expect(page.getByRole('button', { name: /Desplegar y firmar/i })).toHaveCount(0);

  await boton.click();

  await expect.poll(() => adoptCalls.length).toBe(1);
  expect(adoptCalls[0]).toEqual({ network: 'base-sepolia' });
  await expect(page.getByText(/registrado y verificado/i)).toBeVisible();
});

test('el catálogo explica el estado desplegable y avisa del gas', async ({ page }) => {
  await mockApi(page, { status: 'deployable' });

  await page.goto('/contratos');

  await expect(page.getByText(/Aún no está en esta red/i)).toBeVisible();
  await expect(page.getByText(/cuesta gas/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Desplegar y firmar/i })).toBeVisible();
});
