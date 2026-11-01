import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { responder } from './bot.ts';
import { clasificar, fallasActivas, fallasPendientes, lugaresEnTexto, textoDePublicacion } from './fallas.ts';
import { onRequestGet as verFallas, onRequestPost as recibir } from '../functions/api/fallas.ts';
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
  assert.match(revision, /Falla para publicar/);
  assert.match(revision, /📍 Centro/);
  assert.equal((await fallasActivas(db, T)).length, 0); // todavía no se publicó

  assert.match(await responder(db, 1, '/corregir Inventado', admin), /No encontré un único lugar para: Inventado/);
  assert.match(await responder(db, 1, '/corregir Centro y villa maria', admin), /📍 Centro, Villa María/);

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

test('bot: varios links en un mismo mensaje quedan numerados, se corrigen por número y se publican juntos', async (t) => {
  const db = baseLocal();
  const textos: Record<string, string> = {
    1: 'Falla: sin suministro en barrio Centro.',
    2: 'Trabajamos en la red para normalizar el servicio.', // sin lugares
    3: 'Sin luz en Villa Nueva por una falla.',
  };
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const id = decodeURIComponent(String(url)).match(/status\/(\d+)/)?.[1] ?? '';
    return id === '4' ? new Response('', { status: 404 }) : oembed(textos[id]);
  });
  const mensaje = 'Mirá estas:\nhttps://x.com/EPEC/status/1\nhttps://x.com/EPEC/status/2 https://x.com/EPEC/status/3\nhttps://x.com/EPEC/status/4';
  const revision = await responder(db, 1, mensaje, admin);
  assert.match(revision, /No pude leer https:\/\/x\.com\/EPEC\/status\/4/);
  assert.match(revision, /3 fallas para publicar/);
  assert.match(revision, /1\. “Falla: sin suministro en barrio Centro\.”\n {3}📍 Centro/);
  assert.match(revision, /2\. .*\n {3}❓ No reconocí/);
  assert.match(revision, /publicar las 2 que tienen lugares/);

  assert.match(await responder(db, 1, '/corregir Alberdi', admin), /decime el número/); // hay varias
  assert.match(await responder(db, 1, '/corregir 7 Alberdi', admin), /No hay una falla número 7/);
  assert.match(await responder(db, 1, '/corregir 2 Alberdi', admin), /2\. .*\n {3}📍 Alberdi/);
  assert.match(await responder(db, 1, '/cancelar 3', admin), /la descarté[\s\S]*2 fallas para publicar/);

  const avisadas: number[] = [];
  assert.match(await responder(db, 1, '/confirmar', { ...admin, avisarFalla: async (f) => void avisadas.push(f.id) }), /Publiqué 2 fallas: Centro, Alberdi/);
  assert.equal(avisadas.length, 2);
  assert.equal((await fallasActivas(db, T)).length, 2);
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

test('clasificar: falla, servicio restablecido u otra cosa', () => {
  assert.equal(clasificar('Por una falla en la red, usuarios de B° Alberdi se encuentran sin suministro.'), 'falla');
  // Un tweet real de @EpecOficial (1/11/2026): "Informamos al normalizar" no es que ya volvió.
  assert.equal(clasificar('Barrios Valle Escondido, Los Boulevares y Arguello Lourdes ➡️ restricción del servicio. Informamos al normalizar'), 'falla');
  assert.equal(clasificar('Se restableció el servicio en barrio Alberdi.'), 'restablecida');
  assert.equal(clasificar('Quedó normalizado el suministro en Centro.'), 'restablecida');
  assert.equal(clasificar('Cortes programados para mañana por mantenimiento.'), 'otra');
  assert.equal(clasificar('Pagá tu factura online.'), 'otra');
});

test('POST /api/fallas: pide la clave, valida, no repite y deja las fallas esperando /confirmar en el bot', async (t) => {
  const env = { DB: baseLocal(), FALLAS_CLAVE: 'clave-del-extractor', TELEGRAM_TOKEN: 'token', TELEGRAM_ADMIN: '1' };
  const enviar = (cuerpo: unknown, clave = 'clave-del-extractor') => recibir({
    request: new Request('http://x/api/fallas', {
      method: 'POST', headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    }),
    env,
  });
  const alAdmin: { chat_id: number; text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, opciones: RequestInit) => {
    alAdmin.push(JSON.parse(String(opciones.body)));
    return new Response('{}');
  });
  const falla = { id: '1985', url: 'https://x.com/EpecOficial/status/1985', texto: 'Por una falla, sin suministro en barrio Centro.' };

  assert.equal((await enviar(falla, 'otra')).status, 401);
  assert.equal((await recibir({ request: new Request('http://x/api/fallas', { method: 'POST', body: '{}' }), env: { DB: env.DB } })).status, 503);
  assert.match((await (await enviar({ ...falla, url: 'javascript:alert(1)' })).json()).error, /"url" tiene que ser un link https/);
  assert.equal((await enviar({ publicaciones: Array(21).fill(falla) })).status, 400);

  // Una sola publicación, con las keys que manda el extractor.
  assert.deepEqual(await (await enviar(falla)).json(), { resultados: [{ id: '1985', estado: 'pendiente', lugares: ['Centro'] }] });
  assert.equal(alAdmin.length, 1);
  assert.equal(alAdmin[0].chat_id, 1);
  assert.match(alAdmin[0].text, /Llegaron una falla nueva de EPEC[\s\S]*📍 Centro[\s\S]*\/confirmar/);
  assert.equal((await fallasActivas(env.DB, Date.now())).length, 0); // nada se publica sin confirmar

  // Varias juntas: la repetida no se duplica, lo que no es falla se ignora y la de "volvió la luz" se avisa.
  const { resultados } = await (await enviar({
    publicaciones: [
      falla,
      { id: '1986', url: 'https://x.com/EpecOficial/status/1986', texto: 'Cortes programados para mañana.' },
      { id: '1987', url: 'https://x.com/EpecOficial/status/1987', texto: 'Se restableció el servicio en barrio Centro.' },
    ],
  })).json();
  assert.deepEqual(resultados.map((r: { estado: string }) => r.estado), ['repetida', 'ignorada', 'restablecida']);
  assert.match(alAdmin[1].text, /volvió el servicio en Centro.*\/fin_falla/);
  assert.equal((await fallasPendientes(env.DB)).length, 1);

  // Si el extractor reenvía el mismo lote (por ejemplo, porque no pudo guardar el último id), se absorbe en silencio.
  const reenvio = await (await enviar({
    publicaciones: [falla, { id: '1987', url: 'https://x.com/EpecOficial/status/1987', texto: 'Se restableció el servicio en barrio Centro.' }],
  })).json();
  assert.deepEqual(reenvio.resultados.map((r: { estado: string }) => r.estado), ['repetida', 'repetida']);
  assert.equal(alAdmin.length, 2); // ningún aviso nuevo al admin
  assert.equal((await fallasActivas(env.DB, Date.now())).length, 0); // el "volvió el servicio" nunca se muestra
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
