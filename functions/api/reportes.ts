import lugares from '../../data/lugares.js';
import { avisosDeVecinos, mandarAvisos } from '../../src/notificaciones.ts';
import { barrioValido, contarReportes, guardarReporte, huellaDe, type BaseDeDatos } from '../../src/reportes.ts';

// API de reportes de vecinos. Cloudflare Pages convierte este archivo en la dirección /api/reportes:
//   GET  → cuántos vecinos reportaron cada barrio en las últimas 3 horas.
//   POST → suma un reporte: { "barrio": "Alberdi" }. Si con ese ya son varios vecinos, avisa a quienes siguen el barrio.
// DB (la base D1) y CLAVE (un texto secreto) se configuran en el panel de Cloudflare, no en el código.

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; CLAVE?: string; TELEGRAM_TOKEN?: string; PUSH_CLAVE?: string };
  waitUntil?: (tarea: Promise<unknown>) => void;
};

const LUGARES = new Set(lugares);
const SEGUNDOS_EN_CACHE = 20;

// La cuenta se guarda unos segundos en la caché de Cloudflare: si alguien pide /api/reportes sin parar,
// no gasta la cuota gratis de la base de datos. En la compu y en los tests no existe y se saltea.
// shortcut: en *.pages.dev Cloudflare puede ignorar esta caché (funciona seguro con un dominio propio); si no anda, no cambia nada.
const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
const claveDeCache = (request: Request) => new Request(new URL('/api/reportes', request.url));

export async function onRequestGet({ request, env }: Contexto) {
  const guardada = await cache?.match(claveDeCache(request));
  const cuenta = guardada ? await guardada.json() : await contarReportes(env.DB, Date.now());
  if (!guardada) {
    await cache?.put(claveDeCache(request), Response.json(cuenta, { headers: { 'Cache-Control': `max-age=${SEGUNDOS_EN_CACHE}` } }));
  }
  // El navegador no la guarda: así, después de reportar, la página ve su reporte enseguida.
  return Response.json(cuenta, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env, waitUntil }: Contexto) {
  if (!env.CLAVE) throw new Error('Falta configurar la variable secreta CLAVE en Cloudflare');
  // Exigir JSON hace que el navegador bloquee los pedidos armados desde otras páginas.
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
    return Response.json({ error: 'Se espera JSON' }, { status: 415 });
  }
  // Un reporte ocupa unas decenas de bytes: no leemos cuerpos gigantes que solo sirven para gastar recursos.
  const cuerpo = await request.text();
  if (cuerpo.length > 1000) return Response.json({ error: 'Pedido demasiado grande' }, { status: 413 });
  const datos = (() => {
    try {
      return JSON.parse(cuerpo) as { barrio?: unknown };
    } catch {
      return null;
    }
  })();
  const barrio = barrioValido(datos?.barrio);
  // Solo lugares que existen en el mapa: nadie puede llenar la base con nombres inventados.
  if (!barrio || !LUGARES.has(barrio)) return Response.json({ error: 'Barrio desconocido' }, { status: 400 });

  const ahora = Date.now();
  // Cloudflare pone la IP de quien pide en este encabezado. No se guarda: solo su huella.
  const huella = await huellaDe(request.headers.get('CF-Connecting-IP') ?? 'desconocida', env.CLAVE, ahora);
  const resultado = await guardarReporte(env.DB, barrio, huella, ahora);
  if (resultado === 'guardado') {
    await cache?.delete(claveDeCache(request)); // que el nuevo reporte se vea ya
    // Los avisos salen después de responder (waitUntil): quien reporta no espera, y si fallan el reporte ya está guardado.
    const avisar = avisosDeVecinos(env.DB, barrio, ahora)
      .then(({ telegram, push }) => mandarAvisos(env.DB, env, telegram, push))
      .catch((error) => console.error('No se pudo avisar a los vecinos', error));
    if (waitUntil) waitUntil(avisar);
    else await avisar; // en los tests no hay waitUntil
  }
  return Response.json({ resultado }, { status: resultado === 'demasiados' ? 429 : 200 });
}
