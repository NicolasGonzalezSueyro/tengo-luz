import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { guardarReporte } from './reportes.ts';
import { responder } from './bot.ts';
import * as admin from '../functions/api/admin.ts';
import * as calendario from '../functions/api/calendario.ts';

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
