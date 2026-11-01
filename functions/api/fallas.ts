import { fallasActivas } from '../../src/fallas.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';

// GET /api/fallas → las fallas que EPEC confirmó y el admin publicó desde el bot (src/fallas.ts), para el mapa.

type Contexto = { request: Request; env: { DB: BaseDeDatos } };

// Como /api/reportes: unos segundos en la caché de Cloudflare para no gastar la cuota gratis de la base.
// shortcut: en *.pages.dev Cloudflare puede ignorar esta caché (funciona seguro con un dominio propio); si no anda, no cambia nada.
const SEGUNDOS_EN_CACHE = 20;
const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;

export async function onRequestGet({ request, env }: Contexto) {
  const clave = new Request(new URL('/api/fallas', request.url));
  const guardada = await cache?.match(clave);
  if (guardada) return new Response(guardada.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const fallas = (await fallasActivas(env.DB, Date.now())).map(({ lugares, texto, fuente, creado, hasta }) => ({ lugares, texto, fuente, creado, hasta }));
  await cache?.put(clave, Response.json(fallas, { headers: { 'Cache-Control': `max-age=${SEGUNDOS_EN_CACHE}` } }));
  return Response.json(fallas, { headers: { 'Cache-Control': 'no-store' } });
}
