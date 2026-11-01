import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { responder } from './bot.ts';
import { fallasActivas, lugaresEnTexto, textoDePublicacion } from './fallas.ts';
import { onRequestGet as verFallas } from '../functions/api/fallas.ts';
import { onRequestPost as webhook } from '../functions/api/telegram.ts';

const LUGARES = ['Alberdi', 'Alto Alberdi', 'Centro', 'Villa María', 'Villa Nueva'];
const T = Date.UTC(2026, 10, 1, 15, 0);
const admin = { lugares: LUGARES, esAdmin: true, ahora: T };

// Así responde el servicio oficial de inserción de X (oEmbed), con el texto dentro de un <p>.
const oembed = (texto: string) => Response.json({
  author_name: 'EPEC',
  html: `<blockquote class="twitter-tweet"><p lang="es" dir="ltr">${texto}</p>&mdash; EPEC (@EPEC) <a href="https://x.com/EPEC/status/1">1 de noviembre</a></blockquote>`,
});

test('lugaresEnTexto: encuentra los lugares en un texto libre, los más largos primero', () => {
  const texto = '⚠️ Por una falla en la red, sin suministro en B° Alto Alberdi y sector de Villa María. Personal trabaja para normalizar.';
  assert.deepEqual(lugaresEnTexto(LUGARES, texto), ['Alto Alberdi', 'Villa María']); // "Alberdi" solo no cuenta
  assert.deepEqual(lugaresEnTexto(LUGARES, 'Trabajamos para normalizar el servicio.'), []);
});

test('textoDePublicacion: lee el texto con oEmbed y si falla devuelve null', async (t) => {
  const pedidos: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => (pedidos.push(String(url)), oembed('Sin luz en B° Centro &amp; Alberdi<br>Ya trabajamos')));
  assert.deepEqual(await textoDePublicacion('https://x.com/EPEC/status/1'), { texto: 'Sin luz en B° Centro & Alberdi\nYa trabajamos', autor: 'EPEC' });
  assert.match(pedidos[0], /^https:\/\/publish\.x\.com\/oembed\?url=https%3A%2F%2Fx\.com%2FEPEC%2Fstatus%2F1/);

  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.equal(await textoDePublicacion('https://x.com/EPEC/status/2'), null);
});

test('bot: el admin comparte el link, revisa los lugares, los corrige y publica la falla', async (t) => {
  const db = baseLocal();
  t.mock.method(globalThis, 'fetch', async () => oembed('Falla en la red: sin suministro en barrio Centro. Trabajamos para normalizar.'));

  // Solo el admin: para cualquier otro, un link no es un comando.
  assert.match(await responder(db, 2, 'https://x.com/EPEC/status/1', { ...admin, esAdmin: false }), /No entendí/);

  const revision = await responder(db, 1, 'https://x.com/EPEC/status/1', admin);
  assert.match(revision, /publicada por EPEC/);
  assert.match(revision, /Lugares que reconocí:\n• Centro/);
  assert.equal((await fallasActivas(db, T)).length, 0); // todavía no se publicó

  assert.match(await responder(db, 1, '/corregir Inventado', admin), /No encontré un único lugar para: Inventado/);
  assert.match(await responder(db, 1, '/corregir Centro y villa maria', admin), /• Centro\n• Villa María/);

  const avisadas: number[] = [];
  const publicada = await responder(db, 1, '/confirmar', { ...admin, avisarFalla: async (f) => void avisadas.push(f.id) });
  assert.match(publicada, /Publicada: Centro, Villa María .* 6 horas/);
  assert.equal(avisadas.length, 1);
  assert.deepEqual((await fallasActivas(db, T)).map((f) => [f.lugares, f.fuente]), [[['Centro', 'Villa María'], 'https://x.com/EPEC/status/1']]);
  assert.equal((await fallasActivas(db, T + 7 * 60 * 60 * 1000)).length, 0); // a las 6 horas se saca sola

  assert.match(await responder(db, 1, '/confirmar', admin), /No hay ninguna falla esperando/);
  assert.match(await responder(db, 1, '/fin_falla', admin), /Saqué la falla/);
  assert.equal((await fallasActivas(db, T + 1)).length, 0);
});

test('bot: texto pegado sin lugares reconocibles no se puede publicar hasta corregirlo, y se puede cancelar', async () => {
  const db = baseLocal();
  const revision = await responder(db, 1, '/falla Hay una falla en la zona, ya trabajamos.', admin);
  assert.match(revision, /No reconocí barrios ni localidades/);
  assert.doesNotMatch(revision, /\/confirmar/);
  assert.match(await responder(db, 1, '/confirmar', admin), /Primero decime los lugares/);
  assert.match(await responder(db, 1, '/cancelar', admin), /descarté/);
  assert.match(await responder(db, 1, '/corregir Centro', admin), /No hay ninguna falla esperando/);
});

test('webhook: al confirmar avisa por Telegram a quienes siguen esos lugares, una sola vez, y /api/fallas la muestra', async (t) => {
  const env = { DB: baseLocal(), SECRETO_BOT: 'secreto', TELEGRAM_ADMIN: '1', TELEGRAM_TOKEN: 'token' };
  const mensaje = (chat: number, text: string) => webhook({
    request: new Request('http://x/api/telegram', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secreto' }, body: JSON.stringify({ message: { chat: { id: chat }, text } }),
    }),
    env,
  });
  const respuesta = async (chat: number, text: string) => (await (await mensaje(chat, text)).json()).text as string;

  await respuesta(2, '/barrio Centro');
  await respuesta(3, '/barrio Alberdi');
  const enviados: { chat_id: number; text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, opciones: RequestInit) => {
    enviados.push(JSON.parse(String(opciones.body)));
    return new Response('{}');
  });
  await respuesta(1, '/falla EPEC informa: sin suministro en barrio Centro por una falla.');
  assert.match(await respuesta(1, '/confirmar'), /Publicada: Centro/);
  assert.deepEqual(enviados.map((e) => e.chat_id), [2]); // solo quien sigue Centro
  assert.match(enviados[0].text, /EPEC confirmó una falla en Centro/);

  const fallas = await (await verFallas({ request: new Request('http://x/api/fallas'), env })).json();
  assert.deepEqual(fallas.map((f: { lugares: string[] }) => f.lugares), [['Centro']]);
  assert.equal('id' in fallas[0], false); // la API pública no muestra datos internos
});
