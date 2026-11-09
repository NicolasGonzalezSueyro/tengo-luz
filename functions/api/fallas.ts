import lugares, { localidades } from '../../data/lugares.js';
import { resumenPublicadas, revisarFallas, textoRestablecida } from '../../src/bot.ts';
import {
  fallasActivas, fallasPendientes, fallasSinSector, guardarSector, historialDeFallas, nombraCalles, publicacionValida, recibirPublicaciones, type Publicacion,
} from '../../src/fallas.ts';
import { avisosDeFalla, mandarAvisos } from '../../src/notificaciones.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { revisarClave } from '../../src/seguridad.ts';
import { enviarMensaje } from '../../src/telegram.ts';

// /api/fallas: las fallas no programadas que confirma EPEC (src/fallas.ts).
//   GET  → las publicadas, para el mapa (público). Con ?historial: las de los últimos 90 días, para las estadísticas.
//   POST → un extractor externo manda publicaciones de EPEC; las fallas confiables se publican solas y las raras
//          quedan esperando /confirmar en el bot (ver esConfiable).
//          Pide "Authorization: Bearer <FALLAS_CLAVE>". Body: { "id", "url", "texto", "publicado"? }
//          o { "publicaciones": [ … ] } con hasta 20.

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; FALLAS_CLAVE?: string; TELEGRAM_TOKEN?: string; TELEGRAM_ADMIN?: string; PUSH_CLAVE?: string };
  waitUntil?: (tarea: Promise<unknown>) => void;
};

// Como /api/reportes: unos segundos en la caché de Cloudflare para no gastar la cuota gratis de la base.
// shortcut: en *.pages.dev Cloudflare puede ignorar esta caché (funciona seguro con un dominio propio); si no anda, no cambia nada.
const SEGUNDOS_EN_CACHE = 5; // corto: una falla recién publicada tiene que verse enseguida
const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
const MAXIMO_POR_PEDIDO = 20;
const LOCALIDADES = new Set(localidades);

export async function onRequestGet({ request, env }: Contexto) {
  // /api/fallas?historial → las de los últimos 90 días, para las estadísticas (cambia poco: caché de 10 minutos).
  if (new URL(request.url).searchParams.has('historial')) {
    const clave = new Request(new URL('/api/fallas?historial', request.url));
    const guardada = await cache?.match(clave);
    if (guardada) return new Response(guardada.body, { headers: { 'Content-Type': 'application/json' } });
    const historial = await historialDeFallas(env.DB, Date.now() - 90 * 24 * 60 * 60 * 1000);
    await cache?.put(clave, Response.json(historial, { headers: { 'Cache-Control': 'max-age=600' } }));
    return Response.json(historial, { headers: { 'Cache-Control': 'max-age=60' } });
  }
  // /api/fallas?sin-sector (con FALLAS_CLAVE) → las fallas que describen calles y esperan que el robot arme su sector.
  if (new URL(request.url).searchParams.has('sin-sector')) {
    if (!env.FALLAS_CLAVE) return Response.json({ error: 'Clave incorrecta' }, { status: 401 });
    const clave = await revisarClave(request, env.FALLAS_CLAVE, env.DB, env.FALLAS_CLAVE);
    if (clave !== 'ok') return Response.json({ error: clave === 'bloqueado' ? 'Demasiados intentos' : 'Clave incorrecta' }, { status: clave === 'bloqueado' ? 429 : 401 });
    const pendientes = (await fallasSinSector(env.DB, Date.now())).map(({ id, texto, lugares }) => ({ id, texto, lugares }));
    return Response.json(pendientes, { headers: { 'Cache-Control': 'no-store' } });
  }
  const clave = new Request(new URL('/api/fallas', request.url));
  const guardada = await cache?.match(clave);
  if (guardada) return new Response(guardada.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const fallas = (await fallasActivas(env.DB, Date.now()))
    // El sector va solo si la falla nombra calles: las que solo nombran barrios se pintan por barrio (algunas
    // viejas tienen un sector armado por error, por el "se trabaja en el sector" del final).
    .map(({ lugares, texto, fuente, creado, hasta, sector }) => ({ lugares, texto, fuente, creado, hasta, ...(sector && nombraCalles(texto) ? { sector } : {}) }));
  await cache?.put(clave, Response.json(fallas, { headers: { 'Cache-Control': `max-age=${SEGUNDOS_EN_CACHE}` } }));
  return Response.json(fallas, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env, waitUntil }: Contexto) {
  if (!env.FALLAS_CLAVE) return Response.json({ error: 'Falta configurar FALLAS_CLAVE en Cloudflare' }, { status: 503 });
  const clave = await revisarClave(request, env.FALLAS_CLAVE, env.DB, env.FALLAS_CLAVE);
  if (clave !== 'ok') return Response.json({ error: clave === 'bloqueado' ? 'Demasiados intentos' : 'Clave incorrecta' }, { status: clave === 'bloqueado' ? 429 : 401 });
  const cuerpo = await request.text();
  if (cuerpo.length > 60_000) return Response.json({ error: 'Pedido demasiado grande' }, { status: 413 });
  const datos = (() => {
    try {
      return JSON.parse(cuerpo) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!datos || typeof datos !== 'object') return Response.json({ error: 'Se espera JSON' }, { status: 400 });
  // El robot manda los sectores que armó: { "accion": "sectores", "sectores": [{ "id": 3, "sector": [[lon, lat], …] }] }.
  if (datos.accion === 'sectores') {
    const sectores = Array.isArray(datos.sectores) ? (datos.sectores as { id?: unknown; sector?: unknown }[]).slice(0, MAXIMO_POR_PEDIDO) : [];
    let guardados = 0;
    for (const s of sectores) if (typeof s?.id === 'number' && (await guardarSector(env.DB, s.id, s.sector, Date.now()))) guardados++;
    await cache?.delete(new Request(new URL('/api/fallas', request.url))); // que el mapa lo vea enseguida
    return Response.json({ guardados });
  }
  // Una sola publicación ({ id, url, texto }) o varias ({ publicaciones: [ … ] }).
  const lista = Array.isArray(datos.publicaciones) ? datos.publicaciones : [datos];
  if (lista.length === 0 || lista.length > MAXIMO_POR_PEDIDO) {
    return Response.json({ error: `Mandá entre 1 y ${MAXIMO_POR_PEDIDO} publicaciones por pedido` }, { status: 400 });
  }
  const publicaciones: Publicacion[] = [];
  for (const [i, valor] of lista.entries()) {
    const p = publicacionValida(valor);
    if (typeof p === 'string') return Response.json({ error: `Publicación ${i + 1}: ${p}` }, { status: 400 });
    publicaciones.push(p);
  }

  const { resultados, publicadas } = await recibirPublicaciones(env.DB, lugares, LOCALIDADES, publicaciones, Date.now());

  // Después de contestar: avisar a quienes siguen esos lugares, y al admin lo que se publicó solo, lo que tiene
  // que confirmar y lo que dice que volvió la luz.
  const nuevas = resultados.filter((r) => r.estado === 'pendiente' || r.estado === 'sin_lugares').length;
  const restablecidas = resultados.filter((r) => r.estado === 'restablecida');
  const tareas: Promise<unknown>[] = [];
  if (publicadas.length > 0) {
    tareas.push((async () => {
      for (const falla of publicadas) {
        const { telegram, push } = await avisosDeFalla(env.DB, falla);
        await mandarAvisos(env.DB, env, telegram, push);
      }
    })().catch((e) => console.error('No se pudo avisar de las fallas', e)));
  }
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_ADMIN && (publicadas.length > 0 || nuevas > 0 || restablecidas.length > 0)) {
    const partes = [
      ...(publicadas.length > 0 ? [resumenPublicadas(publicadas)] : []),
      ...restablecidas.map(textoRestablecida),
      ...(nuevas > 0 ? [revisarFallas(await fallasPendientes(env.DB), [`📥 ${nuevas === 1 ? 'Esta necesita' : `Estas ${nuevas} necesitan`} que la revises:`])] : []),
    ];
    // Telegram no manda mensajes de más de 4096 caracteres.
    const texto = partes.join('\n\n').slice(0, 4000);
    tareas.push(enviarMensaje(env.TELEGRAM_TOKEN, Number(env.TELEGRAM_ADMIN), texto).catch((e) => console.error('No se pudo avisar al admin', e)));
  }
  const todas = Promise.all(tareas);
  if (waitUntil) waitUntil(todas);
  else await todas; // en los tests no hay waitUntil
  return Response.json({ resultados });
}
