import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseLocal } from './base-local.ts';
import { responder } from './bot.ts';
import { clasificar, esConfiable, fallasActivas, fallasPendientes, lugaresEnTexto, reconocerLugares, textoDePublicacion } from './fallas.ts';
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

test('reconocerLugares: barrios del interior con su localidad, y nunca el barrio de capital con el mismo nombre', () => {
  const lugares = ['Centro', 'Alberdi', 'Argüello Lourdes', 'Santa Isabel 2ª Sección', 'Villa María', 'Centro (Villa María)', 'Valle Escondido (Villa María)', 'La Calera', 'Covico (La Calera)'];
  const localidades = new Set(['Villa María', 'La Calera']);
  const reconocer = (texto: string) => reconocerLugares(lugares, localidades, texto);
  assert.deepEqual(reconocer('Villa María: falla en barrio Centro, sin suministro.'), ['Centro (Villa María)']);
  assert.deepEqual(reconocer('La Calera: sin suministro en barrios Covicco y Centro.'), ['Covico (La Calera)']); // el Centro de capital no
  assert.deepEqual(reconocer('Corte total en la localidad de La Calera.'), ['La Calera']); // sin barrios: la localidad
  assert.deepEqual(reconocer('Sin suministro en barrios Alberdi y Arguello Lourdes.').sort(), ['Alberdi', 'Argüello Lourdes']);
  assert.deepEqual(reconocer('Falla en barrio Santa Isabel 2.'), ['Santa Isabel 2ª Sección']);
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

  // Una falla clara se publica sola: le avisa a quien sigue el barrio y al admin, con los comandos para corregirla.
  await responder(env.DB, 7, '/barrio Centro', { lugares: ['Centro'], esAdmin: false });
  assert.deepEqual(await (await enviar(falla)).json(), { resultados: [{ id: '1985', estado: 'publicada', lugares: ['Centro'] }] });
  const [publicada] = await fallasActivas(env.DB, Date.now());
  assert.deepEqual(publicada.lugares, ['Centro']);
  assert.deepEqual(alAdmin.map((m) => m.chat_id).sort(), [1, 7]);
  const alAdminPrimero = alAdmin.find((m) => m.chat_id === 1)!;
  assert.match(alAdminPrimero.text, new RegExp(`Publiqué solo una falla[\\s\\S]*#${publicada.id} 📍 Centro[\\s\\S]*/fin_falla ${publicada.id}`));
  assert.match(alAdmin.find((m) => m.chat_id === 7)!.text, /EPEC confirmó una falla en Centro/);

  // Varias juntas: la repetida no se duplica, lo que no es falla se ignora, la de "volvió la luz" se avisa,
  // y la rara (no nombra ningún lugar del mapa) espera que el admin la revise.
  alAdmin.length = 0;
  const { resultados } = await (await enviar({
    publicaciones: [
      falla,
      { id: '1986', url: 'https://x.com/EpecOficial/status/1986', texto: 'Cortes programados para mañana.' },
      { id: '1987', url: 'https://x.com/EpecOficial/status/1987', texto: 'Se restableció el servicio en barrio Alberdi.' },
      { id: '1988', url: 'https://x.com/EpecOficial/status/1988', texto: 'Falla en la zona del dique, hay usuarios sin suministro.' },
    ],
  })).json();
  assert.deepEqual(resultados.map((r: { estado: string }) => r.estado), ['repetida', 'ignorada', 'restablecida', 'sin_lugares']);
  assert.equal(alAdmin.length, 1);
  assert.match(alAdmin[0].text, /volvió el servicio en Alberdi. No había fallas publicadas ahí[\s\S]*Esta necesita que la revises[\s\S]*❓ No reconocí[\s\S]*\/corregir/);
  assert.equal((await fallasPendientes(env.DB)).length, 1);

  // Si el extractor reenvía el mismo lote (por ejemplo, porque no pudo guardar el último id), se absorbe en silencio.
  const reenvio = await (await enviar({
    publicaciones: [falla, { id: '1987', url: 'https://x.com/EpecOficial/status/1987', texto: 'Se restableció el servicio en barrio Alberdi.' }],
  })).json();
  assert.deepEqual(reenvio.resultados.map((r: { estado: string }) => r.estado), ['repetida', 'repetida']);
  assert.equal(alAdmin.length, 1); // ningún aviso nuevo
  assert.equal((await fallasActivas(env.DB, Date.now())).length, 1); // el "volvió el servicio" nunca se muestra

  // Desde el bot: verla, sumarle un lugar y sacar solo esa.
  const admin = { lugares: ['Centro', 'Alberdi', 'Alto Alberdi'], esAdmin: true };
  assert.match(await responder(env.DB, 1, '/fallas', admin), new RegExp(`#${publicada.id} 📍 Centro`));
  assert.match(await responder(env.DB, 1, `/agregar ${publicada.id} alberdi`, admin), /Centro, Alberdi/);
  assert.match(await responder(env.DB, 1, '/agregar 999 Alberdi', admin), /No hay una falla publicada con el número 999/);
  assert.match(await responder(env.DB, 1, `/fin_falla ${publicada.id}`, admin), /Saqué la falla/);
  assert.equal((await fallasActivas(env.DB, Date.now() + 1)).length, 0);
});

test('restablecimiento: cuando EPEC dice que volvió el servicio, salen del mapa solo esos lugares', async (t) => {
  const env = { DB: baseLocal(), FALLAS_CLAVE: 'clave', TELEGRAM_TOKEN: 'token', TELEGRAM_ADMIN: '1' };
  const alAdmin: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, opciones: RequestInit) => (alAdmin.push(JSON.parse(String(opciones.body)).text), new Response('{}')));
  let n = 0;
  const publicar = async (texto: string) => (await recibir({
    request: new Request('http://x/api/fallas', {
      method: 'POST', headers: { Authorization: 'Bearer clave' }, body: JSON.stringify({ id: String(++n), url: `https://x.com/EpecOficial/status/${n}`, texto }),
    }),
    env,
  })).json();

  await publicar('Falla: sin suministro en barrios Centro y Alberdi.');
  assert.deepEqual((await fallasActivas(env.DB, Date.now())).map((f) => f.lugares), [['Alberdi', 'Centro']]);

  // Vuelve en una parte: la otra sigue marcada.
  assert.deepEqual((await publicar('Se restableció el servicio en barrio Centro.')).resultados[0].quitados, ['Centro']);
  assert.deepEqual((await fallasActivas(env.DB, Date.now())).map((f) => f.lugares), [['Alberdi']]);
  assert.match(alAdmin.at(-1)!, /volvió el servicio en Centro: lo saqué del mapa/);

  // Vuelve en el resto: la falla termina, pero el historial guarda dónde fue.
  await publicar('Quedó normalizado el suministro en Alberdi.');
  assert.equal((await fallasActivas(env.DB, Date.now())).length, 0);
  const historial = (await env.DB.prepare('SELECT lugares FROM fallas WHERE confirmada = 1').bind().all()).results;
  assert.deepEqual(historial.map((f) => JSON.parse(String(f.lugares))), [['Alberdi']]);

  // Sin lugares reconocibles no se saca nada: se le avisa al admin.
  await publicar('Falla: sin suministro en barrio Centro.');
  await publicar('Ya se normalizó el servicio en la zona.');
  assert.equal((await fallasActivas(env.DB, Date.now())).length, 1);
  assert.match(alAdmin.at(-1)!, /no reconocí en qué lugares/);
});

test('/api/fallas?historial: las fallas publicadas, para las estadísticas, sin las pendientes ni las de "volvió el servicio"', async () => {
  const env = { DB: baseLocal() };
  const db = env.DB;
  const ahora = Date.now();
  await db.prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, ?)').bind('["Centro"]', 'a', 'u1', ahora - 5000, ahora, 1).run();
  await db.prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, ?)').bind('["Alberdi"]', 'b', 'u2', ahora, ahora, 0).run();
  await db.prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, ?)').bind('["Centro"]', 'c', 'u3', ahora, ahora, -1).run();
  const historial = await (await verFallas({ request: new Request('http://x/api/fallas?historial'), env })).json();
  assert.deepEqual(historial, [{ lugares: ['Centro'], creado: ahora - 5000, hasta: ahora }]);
});

test('sectores de fallas: el robot ve las que describen calles, y solo con la clave guarda un sector válido', async () => {
  const env = { DB: baseLocal(), FALLAS_CLAVE: 'clave' };
  const ahora = Date.now();
  const insertar = (texto: string) => env.DB.prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, 1)')
    .bind('["Centro"]', texto, `u${texto.length}`, ahora, ahora + 3_600_000).run();
  await insertar('Sin suministro en barrio Centro, sector comprendido por calles Mitre y Belgrano.');
  await insertar('Sin suministro en barrio Centro.'); // sin calles: no hace falta sector
  const pedir = (url: string, clave?: string, cuerpo?: object) => new Request(url, {
    method: cuerpo ? 'POST' : 'GET', headers: clave ? { Authorization: `Bearer ${clave}` } : {}, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });

  assert.equal((await verFallas({ request: pedir('http://x/api/fallas?sin-sector'), env })).status, 401);
  const pendientes = await (await verFallas({ request: pedir('http://x/api/fallas?sin-sector', 'clave'), env })).json();
  assert.deepEqual(pendientes.map((f: { texto: string }) => f.texto.slice(0, 20)), ['Sin suministro en ba']);
  const id = pendientes[0].id;

  const sector = [[-64.19, -31.41], [-64.18, -31.41], [-64.18, -31.42], [-64.19, -31.41]];
  assert.equal((await recibir({ request: pedir('http://x/api/fallas', 'otra', { accion: 'sectores', sectores: [{ id, sector }] }), env })).status, 401);
  const fuera = [[10, 10], [11, 10], [11, 11]]; // fuera de la provincia: no se acepta
  assert.deepEqual(await (await recibir({ request: pedir('http://x/api/fallas', 'clave', { accion: 'sectores', sectores: [{ id, sector: fuera }] }), env })).json(), { guardados: 0 });
  assert.deepEqual(await (await recibir({ request: pedir('http://x/api/fallas', 'clave', { accion: 'sectores', sectores: [{ id, sector }] }), env })).json(), { guardados: 1 });

  // El mapa lo recibe, y ya no está entre las que esperan.
  const publicas = await (await verFallas({ request: pedir('http://x/api/fallas'), env })).json();
  assert.deepEqual(publicas.find((f: { sector?: unknown }) => f.sector).sector, sector);
  assert.deepEqual(await (await verFallas({ request: pedir('http://x/api/fallas?sin-sector', 'clave'), env })).json(), []);
});

test('bot: compartir un link de "volvió el servicio" saca esos lugares', async (t) => {
  const db = baseLocal();
  t.mock.method(globalThis, 'fetch', async () => oembed('Falla: sin suministro en barrio Centro.'));
  await responder(db, 1, 'https://x.com/EPEC/status/1', admin);
  await responder(db, 1, '/confirmar', admin);
  t.mock.method(globalThis, 'fetch', async () => oembed('Se restableció el servicio en barrio Centro.'));
  assert.match(await responder(db, 1, 'https://x.com/EPEC/status/2', admin), /volvió el servicio en Centro: lo saqué del mapa/);
  assert.equal((await fallasActivas(db, T)).length, 0);
});

test('esConfiable: con lugares, y sin mezclar localidades del interior con barrios de capital', () => {
  const localidades = new Set(['Villa María', 'Alta Gracia']);
  assert.equal(esConfiable(['Centro', 'Alberdi'], localidades), true);
  assert.equal(esConfiable(['Villa María', 'Alta Gracia'], localidades), true);
  assert.equal(esConfiable(['Villa María', 'Centro'], localidades), false);
  assert.equal(esConfiable([], localidades), false);
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

test('reconocerLugares usa los alias del interior (como escribe EPEC un barrio que en el mapa se llama distinto)', () => {
  const lugares = ['Dos Hermanos (San Francisco)', 'San Francisco'];
  const alias = { '2 Hermanos (San Francisco)': 'Dos Hermanos (San Francisco)' };
  assert.deepEqual(reconocerLugares(lugares, new Set(['San Francisco']), 'Falla en San Francisco, barrio 2 Hermanos.', alias), ['Dos Hermanos (San Francisco)']);
});