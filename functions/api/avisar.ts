import { avisosPendientes } from '../../src/bot.ts';
import { avisosPushPendientes, mandarAvisos } from '../../src/notificaciones.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { momentoEnCordoba, type Corte } from '../../web/estado.js';

// El robot de GitHub llama a /api/avisar cada hora con los cortes de hoy en adelante (src/avisar.ts).
// Esta función busca quién sigue esos barrios y les avisa, una sola vez por corte: por Telegram y por
// notificación del navegador (si PUSH_CLAVE está configurada).

type Contexto = { request: Request; env: { DB: BaseDeDatos; SECRETO_BOT?: string; TELEGRAM_TOKEN?: string; PUSH_CLAVE?: string } };

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.SECRETO_BOT || request.headers.get('Authorization') !== `Bearer ${env.SECRETO_BOT}`) {
    return new Response('No autorizado', { status: 401 });
  }
  if (!env.TELEGRAM_TOKEN) throw new Error('Falta configurar TELEGRAM_TOKEN en Cloudflare');
  const cortes = (await request.json().catch(() => null)) as Corte[] | null;
  if (!Array.isArray(cortes)) return Response.json({ error: 'Se esperaba la lista de cortes' }, { status: 400 });
  const hoy = momentoEnCordoba().fecha;

  const telegram = await avisosPendientes(env.DB, cortes, hoy);
  const push = env.PUSH_CLAVE ? await avisosPushPendientes(env.DB, cortes, hoy) : [];
  const enviados = await mandarAvisos(env.DB, env, telegram, push);
  return Response.json({ enviados, pendientes: telegram.length + push.length - enviados });
}
