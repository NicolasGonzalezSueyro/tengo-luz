import { estadisticas, limpiarReportes } from '../../src/admin.ts';
import { SITIO } from '../../src/bot.ts';
import { olvidarNavegador } from '../../src/notificaciones.ts';
import { enviarPush, type ClavePush } from '../../src/push.ts';
import { barrioValido, type BaseDeDatos } from '../../src/reportes.ts';
import { revisarClave } from '../../src/seguridad.ts';
import { enviarMensaje } from '../../src/telegram.ts';
import { pedidoValido } from '../../src/contornos.ts';
import { guardarPedido, pedidosPendientes, sacarPedidos } from '../../src/contornos-admin.ts';
import { correrRobot } from '../../src/github.ts';

// La API del panel de admin (web/admin.html). Pide la clave ADMIN_CLAVE, que se configura en Cloudflare.
//   GET  /api/admin → números del sitio, reportes vigentes y barrios más seguidos.
//   POST /api/admin { "accion": "limpiar", "barrio": "Alberdi" } → borra reportes (de un barrio, o todos sin "barrio").
//   POST /api/admin { "accion": "probar-notificaciones" } → manda una notificación de prueba a los celulares suscriptos.
//   POST /api/admin { "accion": "probar-telegram" } → revisa que el bot esté conectado y te manda un mensaje de prueba.
//   GET  /api/admin?contornos → los cambios de contornos que esperan que el robot los publique.
//   POST /api/admin { "accion": "contorno" | "borrar" | "restaurar", "nombre", "destino", "localidad"?, "geometria"? }
//        → un cambio del editor de contornos (/admin-contornos). Queda esperando y se le pide al robot de GitHub que
//          lo aplique y publique el sitio (contornos.yml, con el secreto GITHUB_TOKEN).
//   POST /api/admin { "accion": "cancelar-contorno", "id": 3 } → descarta un cambio que todavía no se publicó.

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; ADMIN_CLAVE?: string; PUSH_CLAVE?: string; TELEGRAM_TOKEN?: string; TELEGRAM_ADMIN?: string; GITHUB_TOKEN?: string };
};

/** Revisa la clave antes de cualquier cosa. Devuelve la respuesta de error, o null si está todo bien. */
async function rechazar({ request, env }: Contexto) {
  if (!env.ADMIN_CLAVE) return Response.json({ error: 'Falta configurar ADMIN_CLAVE en Cloudflare' }, { status: 503 });
  const resultado = await revisarClave(request, env.ADMIN_CLAVE, env.DB, env.ADMIN_CLAVE);
  if (resultado === 'bloqueado') return Response.json({ error: 'Demasiados intentos: probá de nuevo en 15 minutos' }, { status: 429 });
  if (resultado === 'mala') return Response.json({ error: 'Clave incorrecta' }, { status: 401 });
  return null;
}

export async function onRequestGet(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const datos = new URL(contexto.request.url).searchParams.has('contornos')
    ? await pedidosPendientes(contexto.env.DB)
    : await estadisticas(contexto.env.DB, Date.now());
  return Response.json(datos, { headers: { 'Cache-Control': 'no-store' } });
}

/** Un cambio del editor de contornos: se guarda en la lista de espera y se le pide al robot que lo publique. */
async function cambiarContorno({ env }: Contexto, datos: unknown) {
  const pedido = pedidoValido(datos);
  if (typeof pedido === 'string') return Response.json({ error: pedido }, { status: 400 });
  await guardarPedido(env.DB, pedido, Date.now());
  const robot = env.GITHUB_TOKEN ? ((await correrRobot(env.GITHUB_TOKEN, 'contornos.yml')) ? 'pedido' : 'fallo') : 'sin token';
  return Response.json({ guardado: true, robot });
}

/** Manda una notificación de prueba a todos los celulares suscriptos (para comprobar que llegan de verdad). */
async function probarNotificaciones({ env }: Contexto) {
  if (!env.PUSH_CLAVE) return Response.json({ error: 'Falta configurar PUSH_CLAVE en Cloudflare' }, { status: 503 });
  const clave = JSON.parse(env.PUSH_CLAVE) as ClavePush;
  const filas = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_suscripciones GROUP BY endpoint LIMIT 40').bind().all()).results;
  let entregadas = 0;
  for (const f of filas) {
    const suscripcion = { endpoint: String(f.endpoint), keys: { p256dh: String(f.p256dh), auth: String(f.auth) } };
    const respuesta = await enviarPush(suscripcion, { titulo: '🔔 Prueba de ¿Tengo luz?', cuerpo: 'Si ves esto, las notificaciones andan.', url: './' }, clave, SITIO);
    if (respuesta.ok) entregadas++;
    else if (respuesta.status === 404 || respuesta.status === 410) await olvidarNavegador(env.DB, suscripcion.endpoint);
  }
  return Response.json({ entregadas, total: filas.length });
}

/**
 * ¿Anda el bot? Le pregunta a Telegram si el bot recibe los mensajes en /api/telegram (el "webhook"),
 * cuántos quedaron sin entregar y cuál fue el último error, y le manda un mensaje de prueba al admin.
 */
async function probarTelegram({ env }: Contexto) {
  if (!env.TELEGRAM_TOKEN) return Response.json({ error: 'Falta configurar TELEGRAM_TOKEN en Cloudflare' }, { status: 503 });
  if (!env.TELEGRAM_ADMIN) return Response.json({ error: 'Falta configurar TELEGRAM_ADMIN en Cloudflare' }, { status: 503 });
  const info = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getWebhookInfo`).catch(() => null);
  if (!info) return Response.json({ error: 'No se pudo conectar con Telegram' }, { status: 502 });
  if (info.status === 401) return Response.json({ error: 'Telegram dice que el token del bot (TELEGRAM_TOKEN) es incorrecto' }, { status: 502 });
  const { result } = (await info.json()) as { result?: { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string } };
  const mensaje = await enviarMensaje(env.TELEGRAM_TOKEN, Number(env.TELEGRAM_ADMIN), '🤖 Prueba desde el panel de admin: el bot anda y te puede escribir.');
  return Response.json({
    enviado: mensaje.ok,
    // Solo se dice si está conectado a este sitio: la dirección completa y el token no salen del servidor.
    conectado: Boolean(result?.url?.endsWith('/api/telegram')),
    pendientes: result?.pending_update_count ?? 0,
    ultimoError: result?.last_error_message ? { mensaje: result.last_error_message, fecha: (result.last_error_date ?? 0) * 1000 } : null,
  });
}

export async function onRequestPost(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  // Un contorno puede tener hasta 5000 puntos (~250 KB): más que eso no se lee.
  const cuerpo = await contexto.request.text();
  if (cuerpo.length > 400_000) return Response.json({ error: 'Pedido demasiado grande' }, { status: 413 });
  const datos = (() => {
    try {
      return JSON.parse(cuerpo) as { accion?: unknown; barrio?: unknown; id?: unknown };
    } catch {
      return null;
    }
  })();
  if (['contorno', 'borrar', 'restaurar'].includes(datos?.accion as string)) return cambiarContorno(contexto, datos);
  if (datos?.accion === 'cancelar-contorno') {
    return Number.isInteger(datos.id) ? Response.json({ sacados: await sacarPedidos(contexto.env.DB, [datos.id as number]) }) : Response.json({ error: 'Falta el id' }, { status: 400 });
  }
  if (datos?.accion === 'probar-notificaciones') return probarNotificaciones(contexto);
  if (datos?.accion === 'probar-telegram') return probarTelegram(contexto);
  if (datos?.accion !== 'limpiar') return Response.json({ error: 'Acción desconocida' }, { status: 400 });
  const barrio = datos.barrio === undefined ? undefined : barrioValido(datos.barrio);
  if (barrio === null) return Response.json({ error: 'Barrio inválido' }, { status: 400 });
  return Response.json({ borrados: await limpiarReportes(contexto.env.DB, barrio) });
}
