import { avisosPendientes, marcarAvisado, olvidarChat } from '../../src/bot.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { momentoEnCordoba, type Corte } from '../../web/estado.js';

// El robot de GitHub llama a /api/avisar cada hora con los cortes de hoy en adelante (src/avisar.ts).
// Esta función busca quién sigue esos barrios y les manda el aviso por Telegram, una sola vez por corte.

type Contexto = { request: Request; env: { DB: BaseDeDatos; SECRETO_BOT?: string; TELEGRAM_TOKEN?: string } };

// shortcut: Cloudflare gratis deja hacer ~50 pedidos a otros sitios por llamada. Si hay más avisos, los que
// faltan salen en la llamada de la hora siguiente. Si algún día hay muchos suscriptos, mandarlos desde GitHub Actions.
const MAXIMO_POR_VEZ = 40;

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.SECRETO_BOT || request.headers.get('Authorization') !== `Bearer ${env.SECRETO_BOT}`) {
    return new Response('No autorizado', { status: 401 });
  }
  if (!env.TELEGRAM_TOKEN) throw new Error('Falta configurar TELEGRAM_TOKEN en Cloudflare');
  const cortes = (await request.json().catch(() => null)) as Corte[] | null;
  if (!Array.isArray(cortes)) return Response.json({ error: 'Se esperaba la lista de cortes' }, { status: 400 });

  const pendientes = await avisosPendientes(env.DB, cortes, momentoEnCordoba().fecha);
  let enviados = 0;
  for (const aviso of pendientes.slice(0, MAXIMO_POR_VEZ)) {
    const respuesta = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: aviso.chat, text: aviso.texto, link_preview_options: { is_disabled: true } }),
    });
    if (respuesta.ok) {
      await marcarAvisado(env.DB, aviso, Date.now());
      enviados++;
    } else if (respuesta.status === 403) {
      await olvidarChat(env.DB, aviso.chat); // bloqueó al bot
    }
  }
  return Response.json({ enviados, pendientes: pendientes.length - enviados });
}
