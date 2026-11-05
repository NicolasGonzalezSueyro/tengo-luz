import { expect, test, type Page } from '@playwright/test';

// Recorridos reales por la página. Usan los datos del repo (data/), así que no dependen de qué cortes haya hoy:
// se apoyan en barrios que siempre existen (Alberdi, Centro, Argüello).

/** Junta los errores de la página (código que falla, recursos que no cargan) para revisar al final. */
function vigilarErrores(page: Page) {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errores.push(m.text());
  });
  return errores;
}

const barrioElegido = (page: Page) => page.locator('.panel-contenido h2');

test('carga el mapa con todos los barrios, la lista de cortes y sin errores', async ({ page }) => {
  const errores = vigilarErrores(page);
  await page.goto('/');
  await expect(page.locator('.hero-numero')).toBeVisible();
  await expect.poll(() => page.locator('path.leaflet-interactive').count()).toBeGreaterThan(400);
  await expect(page.getByRole('button', { name: /Hoy/ })).toHaveAttribute('aria-pressed', 'true');
  expect(errores).toEqual([]);
});

test('el buscador autocompleta mientras se escribe y abre el barrio', async ({ page }) => {
  await page.goto('/');
  const buscador = page.getByRole('combobox', { name: 'Buscar barrio' });
  await buscador.pressSequentially('alber');
  // El de capital, no "Alberdi de Horizonte" ni "Alberdi Norte (Río Cuarto)" (el texto puede sumar "Sin luz").
  const opcion = page.locator('[role="option"][data-nombre="Alberdi"]');
  await expect(opcion).toBeVisible();
  await opcion.click();
  await expect(barrioElegido(page)).toHaveText('Alberdi');
  await expect(page).toHaveURL(/\?barrio=Alberdi$/);
});

test('un link compartido abre directo el barrio, aunque no tenga tildes', async ({ page }) => {
  await page.goto('/?barrio=arguello');
  await expect(barrioElegido(page)).toHaveText('Argüello');
  await expect(page).toHaveURL(/\?barrio=Arg%C3%BCello$/);
});

test('una falla confirmada por EPEC se ve en la portada, en el mapa y en la ficha', async ({ page }) => {
  const errores = vigilarErrores(page);
  await page.route('**/api/fallas', (ruta) => ruta.fulfill({
    json: [{ lugares: ['Alberdi'], texto: 'Por una falla, sin suministro en barrio Alberdi.', fuente: 'https://x.com/EPEC/status/1', creado: Date.now(), hasta: Date.now() + 3_600_000 }],
  }));
  await page.route('**/api/reportes', (ruta) => ruta.fulfill({ json: { Alberdi: { cantidad: 2, ultimo: Date.now() } } }));
  await page.goto('/');
  // Los reportes de vecinos son un punto aparte, encima del barrio con la falla.
  await expect(page.locator('path.punto-vecinos')).toHaveCount(1);
  const portada = page.locator('.fallas');
  await expect(portada.getByText('Falla confirmada por EPEC')).toBeVisible();
  await expect(portada.getByText('sin suministro en barrio Alberdi')).toBeVisible();
  await portada.getByRole('button', { name: 'Alberdi' }).click();
  await expect(barrioElegido(page)).toHaveText('Alberdi');
  await expect(page.locator('.estado.falla')).toHaveText('Falla confirmada por EPEC');
  await expect(page.getByRole('link', { name: 'Ver publicación de EPEC' })).toHaveAttribute('href', 'https://x.com/EPEC/status/1');
  expect(errores).toEqual([]);
});

test('una falla publicada con la página abierta aparece sola, sin recargar, y arriba dice la hora de actualización', async ({ page }) => {
  let fallas: object[] = [];
  await page.route('**/api/fallas', (ruta) => ruta.fulfill({ json: fallas }));
  await page.goto('/');
  await expect(page.locator('#actualizado')).toHaveText(/^Última actualización \d{2}:\d{2}$/);
  await expect(page.locator('.fallas')).toHaveCount(0);

  fallas = [{ lugares: ['Centro'], texto: 'Sin suministro en barrio Centro.', fuente: null, creado: Date.now(), hasta: Date.now() + 3_600_000 }];
  // Lo mismo que pasa al volver a la app en el celu (o a los 30 segundos solo).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.fallas').getByText('Sin suministro en barrio Centro.')).toBeVisible();
});

test('las localidades del interior también tienen su ficha y se dibujan aunque no tengan cortes', async ({ page }) => {
  await page.goto('/?barrio=villa maria');
  await expect(barrioElegido(page)).toHaveText('Villa María');
  await expect(page.locator('path.barrio-elegido, path.leaflet-interactive').first()).toBeVisible();
});

test('reportar "No tengo luz": se acepta una vez y la misma conexión no puede repetir en otro barrio', async ({ page }, info) => {
  test.skip(info.project.name !== 'compu', 'El servidor de prueba es uno solo: el límite por conexión se prueba una vez.');
  await page.goto('/?barrio=Alberdi');
  await page.getByRole('button', { name: 'No tengo luz' }).click();
  await expect(page.locator('#aviso-flotante')).toContainText('¡Gracias!');
  await expect(page.locator('#panel-contenido')).toContainText('vecino reportó');

  await page.goto('/?barrio=Centro');
  await page.getByRole('button', { name: 'No tengo luz' }).click();
  await expect(page.locator('#aviso-flotante')).toContainText('una sola vez cada 3 horas');
});

test('el formulario de reclamo arma el mensaje de WhatsApp para EPEC sin mandarlo solo', async ({ page }) => {
  await page.goto('/?barrio=Alberdi');
  // No abrimos WhatsApp de verdad: guardamos el link que se hubiera abierto.
  await page.evaluate(() => {
    (window as unknown as { abierto: string }).abierto = '';
    window.open = (url) => {
      (window as unknown as { abierto: string }).abierto = String(url);
      return null;
    };
  });
  await page.getByRole('button', { name: 'Armar el reclamo a EPEC' }).click();
  await page.getByRole('textbox', { name: 'Número de contrato' }).fill('1234567');
  await page.getByRole('textbox', { name: 'Dirección', exact: true }).fill('Duarte Quirós 1500');
  await page.getByRole('button', { name: 'Enviar por WhatsApp' }).click();
  const link = await page.evaluate(() => (window as unknown as { abierto: string }).abierto);
  expect(link).toMatch(/^https:\/\/wa\.me\/5493512004343\?text=/);
  const mensaje = decodeURIComponent(link.split('text=')[1]);
  expect(mensaje).toContain('N° de contrato: 1234567');
  expect(mensaje).toContain('Dirección: Duarte Quirós 1500, barrio Alberdi');
});

test('en el celular nada se sale de la pantalla', async ({ page }, info) => {
  test.skip(info.project.name !== 'celular', 'Solo tiene sentido en pantalla chica.');
  await page.goto('/?barrio=Alberdi');
  await expect(barrioElegido(page)).toHaveText('Alberdi');
  const [ancho, contenido] = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
  expect(contenido).toBeLessThanOrEqual(ancho);
});

test('el botón de notificaciones aparece y la API da la clave para suscribirse', async ({ page }) => {
  await page.goto('/?barrio=Centro');
  const boton = page.getByRole('button', { name: 'Avisarme' });
  await expect(boton).toBeVisible();
  // La API entrega la clave pública que el navegador necesita para suscribirse.
  const respuesta = await page.request.get('/api/push');
  expect(respuesta.ok()).toBe(true);
  expect((await respuesta.json()).clavePublica).toMatch(/^[A-Za-z0-9_-]{87}$/);
});

test('el panel de admin pide la clave y muestra los números', async ({ page }) => {
  await page.goto('/admin.html');
  await page.locator('#clave').fill('una-equivocada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('#error')).toHaveText('Clave incorrecta');

  await page.locator('#clave').fill('solo-para-probar'); // la clave de prueba de `npm run dev`
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('barrios con reportes')).toBeVisible();
});

test('la página de estadísticas dibuja los gráficos y se llega desde el menú', async ({ page }) => {
  const errores = vigilarErrores(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.getByRole('link', { name: 'Estadísticas' }).click();
  await expect(page.getByRole('heading', { name: 'Barrios y localidades con más cortes' })).toBeVisible();
  await expect.poll(() => page.locator('.barra-relleno').count()).toBeGreaterThan(0);
  await expect(page.getByText('cortes anunciados')).toBeVisible();
  expect(errores).toEqual([]);
});

test('el sitio manda las cabeceras de seguridad', async ({ request }) => {
  const respuesta = await request.get('/');
  const cabeceras = respuesta.headers();
  expect(cabeceras['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(cabeceras['x-frame-options']).toBe('DENY');
  expect(cabeceras['x-content-type-options']).toBe('nosniff');
});
