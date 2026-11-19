import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { guardarReporte } from './reportes.ts';
import { responder } from './bot.ts';
import * as admin from '../functions/api/admin.ts';
import * as calendario from '../functions/api/calendario.ts';
import * as contornos from '../functions/api/contornos.ts';

const T = Date.now();

test('/api/admin: sin la clave no muestra ni borra nada', async () => {
  const pedido = (clave?: string) => new Request('http://x/api/admin', { headers: clave ? { Authorization: `Bearer ${clave}` } : {} });
  const DB = baseLocal();
  assert.equal((await admin.onRequestGet({ request: pedido('x'), env: { DB } })).status, 503); // falta configurarla
  assert.equal((await admin.onRequestGet({ request: pedido(), env: { DB, ADMIN_CLAVE: 'secreta' } })).status, 401);
  assert.equal((await admin.onRequestGet({ request: pedido('secret'), env: { DB, ADMIN_CLAVE: 'secreta' } })).status, 401);
  const post = new Request('http://x/api/admin', { method: 'POST', headers: { Authorization: 'Bearer otra' }, body: '{"accion":"limpiar"}' });
  assert.equal((await admin.onRequestPost({ request: post, env: { DB, ADMIN_CLAVE: 'secreta' } })).status, 401);
});

test('/api/admin: muestra los números y borra reportes', async () => {
  const env = { DB: baseLocal(), ADMIN_CLAVE: 'secreta' };
  const opciones = { lugares: ['Alberdi', 'Centro'], esAdmin: false };
  await responder(env.DB, 1, '/barrio Alberdi', opciones);
  await responder(env.DB, 2, '/barrio Alberdi', opciones);
  await responder(env.DB, 2, '/barrio Centro', opciones);
  await guardarReporte(env.DB, 'Alberdi', 'ana', T);
  await guardarReporte(env.DB, 'Centro', 'beto', T);
  const pedir = (metodo: string, cuerpo?: object) => new Request('http://x/api/admin', {
    method: metodo, headers: { Authorization: 'Bearer secreta' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });

  const datos = await (await admin.onRequestGet({ request: pedir('GET'), env })).json();
  assert.equal(datos.personas, 2);
  assert.equal(datos.barriosSeguidos, 3);
  assert.deepEqual(datos.masSeguidos, [{ barrio: 'Alberdi', personas: 2 }, { barrio: 'Centro', personas: 1 }]);
  assert.deepEqual(Object.keys(datos.reportes).sort(), ['Alberdi', 'Centro']);

  assert.equal((await admin.onRequestPost({ request: pedir('POST', { accion: 'otra' }), env })).status, 400);
  assert.deepEqual(await (await admin.onRequestPost({ request: pedir('POST', { accion: 'limpiar', barrio: 'Alberdi' }), env })).json(), { borrados: 1 });
  assert.deepEqual(await (await admin.onRequestPost({ request: pedir('POST', { accion: 'limpiar' }), env })).json(), { borrados: 1 });
  assert.deepEqual((await (await admin.onRequestGet({ request: pedir('GET'), env })).json()).reportes, {});
});

test('/api/admin: probar el bot revisa el webhook y manda un mensaje al admin, sin mostrar el token', async (t) => {
  const pedir = () => new Request('http://x/api/admin', { method: 'POST', headers: { Authorization: 'Bearer secreta' }, body: '{"accion":"probar-telegram"}' });
  const probar = async (env: object) => admin.onRequestPost({ request: pedir(), env: { DB: baseLocal(), ADMIN_CLAVE: 'secreta', ...env } });
  assert.equal((await probar({})).status, 503); // falta TELEGRAM_TOKEN

  const pedidos: string[] = [];
  let webhook = { url: 'https://tengo-luz.pages.dev/api/telegram', pending_update_count: 0 } as Record<string, unknown>;
  t.mock.method(globalThis, 'fetch', async (url: string, opciones?: RequestInit) => {
    pedidos.push(`${url.replace(/bot[^/]+/, 'bot<token>')} ${opciones?.body ?? ''}`);
    return url.endsWith('getWebhookInfo') ? Response.json({ ok: true, result: webhook }) : Response.json({ ok: true });
  });
  const env = { TELEGRAM_TOKEN: 'token-secreto', TELEGRAM_ADMIN: '9' };
  const bien = await (await probar(env)).json();
  assert.deepEqual(bien, { enviado: true, conectado: true, pendientes: 0, ultimoError: null });
  assert.match(pedidos[1], /sendMessage .*"chat_id":9/);
  assert.doesNotMatch(JSON.stringify(bien), /token-secreto/);

  webhook = { url: '', pending_update_count: 3, last_error_date: 1_700_000_000, last_error_message: 'Wrong response from the webhook: 500' };
  const mal = await (await probar(env)).json();
  assert.equal(mal.conectado, false);
  assert.equal(mal.pendientes, 3);
  assert.deepEqual(mal.ultimoError, { mensaje: 'Wrong response from the webhook: 500', fecha: 1_700_000_000_000 });

  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":false}', { status: 401 }));
  assert.match((await (await probar(env)).json()).error, /token del bot .* incorrecto/);
});

test('/api/calendario entrega el .ics solo de cortes que existen', async () => {
  const cortes = [{
    fecha: '2026-10-31', desde: '08:00', hasta: '13:00', zona: 'Barrio Alberdi.', afectacion: 'parcial',
    fuente: 'https://eldoce.tv/nota', barrios: ['Alberdi'], zonas: [], sinUbicar: [],
  }];
  const env = { ASSETS: { fetch: async () => Response.json(cortes) } };
  const pedir = (consulta: string) => calendario.onRequestGet({ request: new Request(`https://tengo-luz.pages.dev/api/calendario?${consulta}`), env });

  assert.equal((await pedir('fecha=ayer')).status, 400);
  assert.equal((await pedir('fecha=2026-10-31&desde=09:00&hasta=13:00')).status, 404);
  assert.equal((await pedir('fecha=2026-10-31&desde=08:00&hasta=13:00&lugar=Centro')).status, 404);
  const respuesta = await pedir('fecha=2026-10-31&desde=08:00&hasta=13:00&lugar=Alberdi');
  assert.equal(respuesta.status, 200);
  assert.match(String(respuesta.headers.get('Content-Type')), /^text\/calendar/);
  assert.match(await respuesta.text(), /SUMMARY:⚡ Corte de luz en Alberdi/);
});

test('/api/admin: después de 10 claves mal puestas desde la misma conexión, frena 15 minutos', async () => {
  const env = { DB: baseLocal(), ADMIN_CLAVE: 'secreta' };
  const pedido = (clave: string, ip = '1.2.3.4') => new Request('http://x/api/admin', { headers: { Authorization: `Bearer ${clave}`, 'CF-Connecting-IP': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await admin.onRequestGet({ request: pedido(`mala${i}`), env })).status, 401);
  // Ya frenado: ni siquiera con la clave buena (así no sirve seguir probando).
  assert.equal((await admin.onRequestGet({ request: pedido('mala'), env })).status, 429);
  assert.equal((await admin.onRequestGet({ request: pedido('secreta'), env })).status, 429);
  // Otra conexión entra normal.
  assert.equal((await admin.onRequestGet({ request: pedido('secreta', '5.6.7.8'), env })).status, 200);
});
test('/api/admin: el editor de contornos guarda cambios que esperan al robot, y el robot los saca con /api/contornos', async () => {
  const env = { DB: baseLocal(), ADMIN_CLAVE: 'secreta', SECRETO_BOT: 'del-bot' };
  const pedir = (cuerpo?: object, ruta = 'http://x/api/admin', clave = 'secreta') => new Request(ruta, {
    method: cuerpo ? 'POST' : 'GET', headers: { Authorization: `Bearer ${clave}` }, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const contorno = { type: 'Polygon', coordinates: [[[-64.2, -31.4], [-64.19, -31.4], [-64.19, -31.39], [-64.2, -31.4]]] };
  // Sin GITHUB_TOKEN se guarda igual (lo aplica la próxima corrida del robot).
  assert.deepEqual(await (await admin.onRequestPost({ request: pedir({ accion: 'contorno', nombre: 'Los Cielos', destino: 'interior', localidad: 'Córdoba', geometria: contorno }), env })).json(),
    { guardado: true, robot: 'sin token' });
  await admin.onRequestPost({ request: pedir({ accion: 'borrar', nombre: 'Kilómetro 8', destino: 'interior' }), env });
  assert.equal((await admin.onRequestPost({ request: pedir({ accion: 'contorno', nombre: 'X', destino: 'interior' }), env })).status, 400);
  assert.equal((await admin.onRequestPost({ request: pedir({ accion: 'borrar', nombre: 'X', destino: 'interior' }, 'http://x/api/admin', 'otra'), env })).status, 401);

  const pendientes = await (await admin.onRequestGet({ request: pedir(undefined, 'http://x/api/admin?contornos'), env })).json();
  assert.deepEqual(pendientes.map((p: { accion: string; nombre: string }) => [p.accion, p.nombre]), [['contorno', 'Los Cielos'], ['borrar', 'Kilómetro 8']]);
  // El admin cancela uno.
  assert.deepEqual(await (await admin.onRequestPost({ request: pedir({ accion: 'cancelar-contorno', id: pendientes[1].id }), env })).json(), { sacados: 1 });

  // El robot: sin el secreto del bot, nada.
  assert.equal((await contornos.onRequestGet({ request: pedir(undefined, 'http://x/api/contornos', 'secreta'), env })).status, 401);
  const delRobot = await (await contornos.onRequestGet({ request: pedir(undefined, 'http://x/api/contornos', 'del-bot'), env })).json();
  assert.deepEqual(delRobot.map((p: { nombre: string }) => p.nombre), ['Los Cielos']);
  assert.deepEqual(await (await contornos.onRequestPost({ request: pedir({ aplicados: [delRobot[0].id] }, 'http://x/api/contornos', 'del-bot'), env })).json(), { sacados: 1 });
  assert.deepEqual(await (await contornos.onRequestGet({ request: pedir(undefined, 'http://x/api/contornos', 'del-bot'), env })).json(), []);
});
