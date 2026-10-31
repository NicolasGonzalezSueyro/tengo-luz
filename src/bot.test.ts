import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisosPendientes, buscarLugar, marcarAvisado, olvidarChat, responder } from './bot.ts';
import { baseLocal } from './base-local.ts';
import { guardarReporte } from './reportes.ts';
import { leer, listarLugares } from './lugares.ts';
import lugaresGuardados from '../data/lugares.js';
import { onRequestPost as webhook } from '../functions/api/telegram.ts';
import { onRequestPost as avisar } from '../functions/api/avisar.ts';
import type { Corte } from '../web/estado.js';

const LUGARES = ['Alberdi', 'Alto Alberdi', 'Villa Belgrano', 'Zona rural Ruta 9 Norte'];
const T = Date.UTC(2026, 9, 30, 15, 0);
const usuario = { lugares: LUGARES, esAdmin: false, ahora: T };
const admin = { ...usuario, esAdmin: true };

const corte = (fecha: string, barrios: string[], zonas: string[] = []): Corte => ({
  fecha, desde: '08:00', hasta: '13:00', zona: `Barrios ${barrios.join(' y ')}`, afectacion: 'parcial',
  fuente: 'https://ejemplo', barrios, zonas, sinUbicar: [],
});

test('data/lugares.js está al día con los mapas (si falla: npm run lugares)', () => {
  assert.deepEqual(lugaresGuardados, listarLugares(leer('barrios.geojson'), leer('zonas.geojson')));
});

test('buscarLugar: exacto sin tildes, o los que contienen el texto', () => {
  assert.deepEqual(buscarLugar(LUGARES, 'ALBERDI'), ['Alberdi']);
  assert.deepEqual(buscarLugar(LUGARES, 'alberd'), ['Alberdi', 'Alto Alberdi']);
  assert.deepEqual(buscarLugar(LUGARES, 'belgrano'), ['Villa Belgrano']);
  assert.deepEqual(buscarLugar(LUGARES, 'nada'), []);
});

test('seguir, listar y borrar barrios', async () => {
  const db = baseLocal();
  assert.doesNotMatch(await responder(db, 1, '/start', usuario), /número de chat/);
  assert.equal(await responder(db, 1, '/mi_id', usuario), 'Tu número de chat es 1.');
  assert.match(await responder(db, 1, '/barrio alberdi', usuario), /Te aviso .* Alberdi/);
  assert.match(await responder(db, 1, '/barrio Alberdi', usuario), /Ya te aviso/);
  assert.match(await responder(db, 1, '/barrio alberd', usuario), /Encontré 2 lugares/);
  assert.match(await responder(db, 1, '/barrio@TengoLuzBot belgrano', usuario), /Villa Belgrano/);
  assert.match(await responder(db, 1, '/barrio', usuario), /Por ejemplo/);
  assert.equal(await responder(db, 1, '/mis_barrios', usuario), 'Te aviso de estos barrios:\n• Alberdi\n• Villa Belgrano');
  assert.match(await responder(db, 2, '/mis_barrios', usuario), /Todavía no/);
  assert.match(await responder(db, 1, '/borrar villa belgrano', usuario), /ya no te aviso de Villa Belgrano/);
  assert.match(await responder(db, 1, '/borrar todo', usuario), /no te mando más/);
  assert.match(await responder(db, 1, '/mis_barrios', usuario), /Todavía no/);
});

test('los comandos de admin solo funcionan para el admin', async () => {
  const db = baseLocal();
  await guardarReporte(db, 'Alberdi', 'ana', T);
  await guardarReporte(db, 'Alberdi', 'beto', T);
  await guardarReporte(db, 'Villa Belgrano', 'ana', T);

  assert.match(await responder(db, 1, '/limpiar', usuario), /No entendí/);
  assert.doesNotMatch(await responder(db, 1, '/ayuda', usuario), /admin/);
  assert.match(await responder(db, 9, '/ayuda', admin), /Comandos de admin/);
  assert.match(await responder(db, 9, '/estado', admin), /Barrios con reportes ahora: 2/);
  assert.match(await responder(db, 9, '/reportes', admin), /Alberdi: 2\n• Villa Belgrano: 1/);
  assert.match(await responder(db, 9, '/limpiar alberdi', admin), /Borré los reportes de Alberdi/);
  assert.match(await responder(db, 9, '/limpiar', admin), /Borré 1 reporte\./);
  assert.match(await responder(db, 9, '/reportes', admin), /No hay reportes/);
});

test('avisos: uno por persona y corte, solo cortes de hoy en adelante, sin repetir', async () => {
  const db = baseLocal();
  await responder(db, 1, '/barrio Alberdi', usuario);
  await responder(db, 1, '/barrio Alto Alberdi', usuario);
  await responder(db, 2, '/barrio Zona rural Ruta 9 Norte', usuario);
  const cortes = [
    corte('2026-10-29', ['Alberdi']), // ya pasó
    corte('2026-10-31', ['Alberdi', 'Alto Alberdi', 'Centro']),
    corte('2026-10-31', [], ['Zona rural Ruta 9 Norte']),
  ];
  const avisos = await avisosPendientes(db, cortes, '2026-10-30');
  assert.equal(avisos.length, 2);
  assert.equal(avisos[0].chat, 1);
  assert.match(avisos[0].texto, /^⚡ Corte programado en Alberdi, Alto Alberdi\n📅 Mañana · sábado 31 de octubre\n🕗 De 08:00 a 13:00 \(parcial\)/);
  assert.equal(avisos[1].chat, 2);

  await marcarAvisado(db, avisos[0], T);
  assert.deepEqual((await avisosPendientes(db, cortes, '2026-10-30')).map((a) => a.chat), [2]);
  await olvidarChat(db, 2);
  assert.deepEqual(await avisosPendientes(db, cortes, '2026-10-30'), []);
});

test('webhook: solo acepta pedidos de Telegram y contesta en la misma respuesta', async () => {
  const env = { DB: baseLocal(), SECRETO_BOT: 'secreto', TELEGRAM_ADMIN: '9' };
  const pedido = (secreto: string, cuerpo: object) => new Request('http://x/api/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secreto }, body: JSON.stringify(cuerpo),
  });
  assert.equal((await webhook({ request: pedido('otro', {}), env })).status, 401);
  assert.equal((await webhook({ request: pedido('secreto', { message: { chat: { id: 1 }, sticker: {} } }), env })).status, 200);

  const respuesta = await (await webhook({ request: pedido('secreto', { message: { chat: { id: 9 }, text: '/ayuda' } }), env })).json();
  assert.equal(respuesta.method, 'sendMessage');
  assert.equal(respuesta.chat_id, 9);
  assert.match(respuesta.text, /Comandos de admin/);
});

test('/api/avisar manda los avisos por Telegram y los marca', async (t) => {
  const env = { DB: baseLocal(), SECRETO_BOT: 'secreto', TELEGRAM_TOKEN: 'token' };
  await responder(env.DB, 1, '/barrio Alberdi', usuario);
  await responder(env.DB, 2, '/barrio Alberdi', usuario);
  const mandados: unknown[] = [];
  // En vez de llamar a Telegram de verdad: el chat 2 "bloqueó al bot".
  t.mock.method(globalThis, 'fetch', async (_url: string, opciones: RequestInit) => {
    const cuerpo = JSON.parse(String(opciones.body));
    mandados.push(cuerpo.chat_id);
    return new Response('{}', { status: cuerpo.chat_id === 2 ? 403 : 200 });
  });
  const pedido = (clave: string) => new Request('http://x/api/avisar', {
    method: 'POST', headers: { Authorization: `Bearer ${clave}` }, body: JSON.stringify([corte('2099-01-01', ['Alberdi'])]),
  });

  assert.equal((await avisar({ request: pedido('otra'), env })).status, 401);
  assert.deepEqual(await (await avisar({ request: pedido('secreto'), env })).json(), { enviados: 1, pendientes: 1 });
  assert.deepEqual(mandados, [1, 2]);
  // La segunda vez no hay nada: el 1 ya fue avisado y el 2 se borró por bloquear al bot.
  assert.deepEqual(await (await avisar({ request: pedido('secreto'), env })).json(), { enviados: 0, pendientes: 0 });
});
