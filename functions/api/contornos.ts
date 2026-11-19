import { pedidosPendientes, sacarPedidos } from '../../src/contornos-admin.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { claveCorrecta } from '../../src/seguridad.ts';

// /api/contornos: lo usa solo el robot de GitHub (src/aplicar-contornos.ts), con "Authorization: Bearer <SECRETO_BOT>".
//   GET  → los cambios de contornos que hizo el admin y todavía no se aplicaron.
//   POST { "aplicados": [1, 2, 3] } → los saca de la lista (ya están en los mapas publicados).

type Contexto = { request: Request; env: { DB: BaseDeDatos; SECRETO_BOT?: string } };

const autorizado = async ({ request, env }: Contexto) => Boolean(env.SECRETO_BOT) && (await claveCorrecta(request, env.SECRETO_BOT!));

export async function onRequestGet(contexto: Contexto) {
  if (!(await autorizado(contexto))) return new Response('No autorizado', { status: 401 });
  return Response.json(await pedidosPendientes(contexto.env.DB), { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost(contexto: Contexto) {
  if (!(await autorizado(contexto))) return new Response('No autorizado', { status: 401 });
  const datos = (await contexto.request.json().catch(() => null)) as { aplicados?: unknown } | null;
  if (!Array.isArray(datos?.aplicados)) return Response.json({ error: 'Se espera { "aplicados": [ids] }' }, { status: 400 });
  return Response.json({ sacados: await sacarPedidos(contexto.env.DB, datos.aplicados as number[]) });
}
