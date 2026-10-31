import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { responder } from './bot.ts';
import { aBase64url, clavePublicaDe, generarClave } from './push.ts';
import * as push from '../functions/api/push.ts';
import { onRequestPost as avisar } from '../functions/api/avisar.ts';
import type { Corte } from '../web/estado.js';

/** Una suscripción como la que da un navegador de verdad (claves reales para poder cifrar). */
async function suscripcionDePrueba(endpoint: string) {
  const par = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    endpoint,
    keys: {
      p256dh: aBase64url(new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey))),
      auth: aBase64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

const post = (cuerpo: object) => new Request('http://x/api/push', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
});

test('/api/push: da la clave pública y guarda o quita suscripciones válidas', async () => {
  const clave = await generarClave();
  const env = { DB: baseLocal(), PUSH_CLAVE: JSON.stringify(clave) };
  assert.equal((await push.onRequestGet({ request: new Request('http://x/api/push'), env: { DB: env.DB } })).status, 503);
  assert.deepEqual(await (await push.onRequestGet({ request: new Request('http://x/api/push'), env })).json(), { clavePublica: clavePublicaDe(clave) });

  const s = await suscripcionDePrueba('https://fcm.googleapis.com/fcm/send/abc');
  assert.equal((await push.onRequestPost({ request: post({ accion: 'agregar', barrio: 'Inventado', suscripcion: s }), env })).status, 400);
  assert.equal((await push.onRequestPost({ request: post({ accion: 'agregar', barrio: 'Alberdi', suscripcion: { ...s, endpoint: 'https://otro.com/x' } }), env })).status, 400);
  assert.equal((await push.onRequestPost({ request: post({ accion: 'agregar', barrio: 'Alberdi', suscripcion: s }), env })).status, 200);
  const filas = async () => (await env.DB.prepare('SELECT barrio FROM push_suscripciones').bind().all()).results.map((r) => r.barrio);
  assert.deepEqual(await filas(), ['Alberdi']);
  assert.equal((await push.onRequestPost({ request: post({ accion: 'quitar', barrio: 'Alberdi', suscripcion: s }), env })).status, 200);
  assert.deepEqual(await filas(), []);
});

test('/api/avisar manda Telegram y notificaciones push cifradas, y olvida los navegadores que ya no existen', async (t) => {
  const clave = await generarClave();
  const env = { DB: baseLocal(), SECRETO_BOT: 'secreto', TELEGRAM_TOKEN: 'token', PUSH_CLAVE: JSON.stringify(clave) };
  await responder(env.DB, 1, '/barrio Alberdi', { lugares: ['Alberdi'], esAdmin: false });
  const vigente = await suscripcionDePrueba('https://fcm.googleapis.com/fcm/send/vigente');
  const vencida = await suscripcionDePrueba('https://updates.push.services.mozilla.com/wpush/v2/vencida');
  for (const s of [vigente, vencida]) await push.onRequestPost({ request: post({ accion: 'agregar', barrio: 'Alberdi', suscripcion: s }), env });

  const pedidos: { url: string; encabezados: Headers; cuerpo: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, opciones: RequestInit) => {
    pedidos.push({ url, encabezados: new Headers(opciones.headers), cuerpo: opciones.body });
    return new Response(null, { status: url.includes('vencida') ? 410 : url.includes('telegram') ? 200 : 201 });
  });
  const cortes: Corte[] = [{
    localidad: 'Córdoba', fecha: '2099-01-01', desde: '08:00', hasta: '13:00', zona: 'Barrio Alberdi.', afectacion: 'parcial',
    fuente: 'https://x', barrios: ['Alberdi'], zonas: [], sinUbicar: [],
  } as Corte];
  const pedido = () => new Request('http://x/api/avisar', { method: 'POST', headers: { Authorization: 'Bearer secreto' }, body: JSON.stringify(cortes) });

  assert.deepEqual(await (await avisar({ request: pedido(), env })).json(), { enviados: 2, pendientes: 1 });
  const alNavegador = pedidos.find((p) => p.url.includes('vigente'))!;
  assert.match(String(alNavegador.encabezados.get('Authorization')), /^vapid t=.+, k=/);
  assert.equal(alNavegador.encabezados.get('Content-Encoding'), 'aes128gcm');
  assert.ok(alNavegador.cuerpo instanceof Uint8Array && alNavegador.cuerpo.length > 86); // encabezado de 86 bytes + mensaje cifrado

  // La segunda vez no hay nada: Telegram y el navegador vigente ya fueron avisados, y el vencido se borró.
  assert.deepEqual(await (await avisar({ request: pedido(), env })).json(), { enviados: 0, pendientes: 0 });
  const quedan = (await env.DB.prepare('SELECT endpoint FROM push_suscripciones').bind().all()).results.map((r) => r.endpoint);
  assert.deepEqual(quedan, [vigente.endpoint]);
});
