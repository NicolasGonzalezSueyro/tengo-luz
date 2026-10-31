import { barrioValido, contarReportes, guardarReporte, huellaDe, type BaseDeDatos } from '../../src/reportes.ts';

// API de reportes de vecinos. Cloudflare Pages convierte este archivo en la dirección /api/reportes:
//   GET  → cuántos vecinos reportaron cada barrio en las últimas 3 horas.
//   POST → suma un reporte: { "barrio": "Alberdi" }.
// DB (la base D1) y CLAVE (un texto secreto) se configuran en el panel de Cloudflare, no en el código.

type Contexto = { request: Request; env: { DB: BaseDeDatos; CLAVE?: string } };

export async function onRequestGet({ env }: Contexto) {
  return Response.json(await contarReportes(env.DB, Date.now()), { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.CLAVE) throw new Error('Falta configurar la variable secreta CLAVE en Cloudflare');
  // Exigir JSON hace que el navegador bloquee los pedidos armados desde otras páginas.
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
    return Response.json({ error: 'Se espera JSON' }, { status: 415 });
  }
  const datos = (await request.json().catch(() => null)) as { barrio?: unknown } | null;
  const barrio = barrioValido(datos?.barrio);
  if (!barrio) return Response.json({ error: 'Falta el barrio' }, { status: 400 });

  const ahora = Date.now();
  // Cloudflare pone la IP de quien pide en este encabezado. No se guarda: solo su huella.
  const huella = await huellaDe(request.headers.get('CF-Connecting-IP') ?? 'desconocida', env.CLAVE, ahora);
  const resultado = await guardarReporte(env.DB, barrio, huella, ahora);
  return Response.json({ resultado }, { status: resultado === 'demasiados' ? 429 : 200 });
}
