import { avisosPendientes, marcarAvisado, olvidarChat, SITIO } from '../../src/bot.ts';
import { avisosPushPendientes, marcarPushAvisado, olvidarNavegador } from '../../src/notificaciones.ts';
import { enviarPush, type ClavePush } from '../../src/push.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { enviarMensaje } from '../../src/telegram.ts';
import { momentoEnCordoba, type Corte } from '../../web/estado.js';

// El robot de GitHub llama a /api/avisar cada hora con los cortes de hoy en adelante (src/avisar.ts).
// Esta función busca quién sigue esos barrios y les avisa, una sola vez por corte: por Telegram y por
// notificación del navegador (si PUSH_CLAVE está configurada).

type Contexto = { request: Request; env: { DB: BaseDeDatos; SECRETO_BOT?: string; TELEGRAM_TOKEN?: string; PUSH_CLAVE?: string } };

// shortcut: Cloudflare gratis deja hacer ~50 pedidos a otros sitios por llamada (Telegram y push suman juntos).
// Si hay más avisos, los que faltan salen en la llamada de la hora siguiente. Si algún día hay muchos
// suscriptos, mandarlos desde GitHub Actions.
const MAXIMO_POR_VEZ = 40;

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.SECRETO_BOT || request.headers.get('Authorization') !== `Bearer ${env.SECRETO_BOT}`) {
    return new Response('No autorizado', { status: 401 });
  }
  if (!env.TELEGRAM_TOKEN) throw new Error('Falta configurar TELEGRAM_TOKEN en Cloudflare');
  const cortes = (await request.json().catch(() => null)) as Corte[] | null;
  if (!Array.isArray(cortes)) return Response.json({ error: 'Se esperaba la lista de cortes' }, { status: 400 });
  const hoy = momentoEnCordoba().fecha;
  let quedan = MAXIMO_POR_VEZ;
  let enviados = 0;

  const telegram = await avisosPendientes(env.DB, cortes, hoy);
  for (const aviso of telegram.slice(0, quedan)) {
    quedan--;
    const respuesta = await enviarMensaje(env.TELEGRAM_TOKEN, aviso.chat, aviso.texto);
    if (respuesta.ok) {
      await marcarAvisado(env.DB, aviso, Date.now());
      enviados++;
    } else if (respuesta.status === 403) {
      await olvidarChat(env.DB, aviso.chat); // bloqueó al bot
    }
  }

  const push = env.PUSH_CLAVE ? await avisosPushPendientes(env.DB, cortes, hoy) : [];
  const clave = env.PUSH_CLAVE ? (JSON.parse(env.PUSH_CLAVE) as ClavePush) : null;
  for (const aviso of clave ? push.slice(0, quedan) : []) {
    quedan--;
    const respuesta = await enviarPush(aviso.suscripcion, aviso.mensaje, clave!, SITIO);
    if (respuesta.ok) {
      await marcarPushAvisado(env.DB, aviso.suscripcion.endpoint, aviso.clave, Date.now());
      enviados++;
    } else if (respuesta.status === 404 || respuesta.status === 410) {
      await olvidarNavegador(env.DB, aviso.suscripcion.endpoint); // la suscripción ya no existe
    }
  }

  return Response.json({ enviados, pendientes: telegram.length + push.length - enviados });
}
