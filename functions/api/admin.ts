import { estadisticas, limpiarReportes } from '../../src/admin.ts';
import { SITIO } from '../../src/bot.ts';
import { olvidarNavegador } from '../../src/notificaciones.ts';
import { enviarPush, type ClavePush } from '../../src/push.ts';
import { barrioValido, type BaseDeDatos } from '../../src/reportes.ts';

// La API del panel de admin (web/admin.html). Pide la clave ADMIN_CLAVE, que se configura en Cloudflare.
//   GET  /api/admin → números del sitio, reportes vigentes y barrios más seguidos.
//   POST /api/admin { "accion": "limpiar", "barrio": "Alberdi" } → borra reportes (de un barrio, o todos sin "barrio").
//   POST /api/admin { "accion": "probar-notificaciones" } → manda una notificación de prueba a los celulares suscriptos.

type Contexto = { request: Request; env: { DB: BaseDeDatos; ADMIN_CLAVE?: string; PUSH_CLAVE?: string } };

const sha256 = async (texto: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));

/**
 * Compara la clave recibida con la verdadera. Se comparan los hash byte por byte sin cortar antes:
 * así el tiempo de respuesta no da pistas de cuántas letras se acertaron.
 */
async function claveCorrecta(request: Request, clave: string) {
  const [dada, real] = await Promise.all([sha256(request.headers.get('Authorization') ?? ''), sha256(`Bearer ${clave}`)]);
  let diferencias = 0;
  for (let i = 0; i < real.length; i++) diferencias |= dada[i] ^ real[i];
  return diferencias === 0;
}

/** Revisa la clave antes de cualquier cosa. Devuelve la respuesta de error, o null si está todo bien. */
async function rechazar({ request, env }: Contexto) {
  if (!env.ADMIN_CLAVE) return Response.json({ error: 'Falta configurar ADMIN_CLAVE en Cloudflare' }, { status: 503 });
  if (!(await claveCorrecta(request, env.ADMIN_CLAVE))) return Response.json({ error: 'Clave incorrecta' }, { status: 401 });
  return null;
}

export async function onRequestGet(contexto: Contexto) {
  return (await rechazar(contexto)) ?? Response.json(await estadisticas(contexto.env.DB, Date.now()), { headers: { 'Cache-Control': 'no-store' } });
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

export async function onRequestPost(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const datos = (await contexto.request.json().catch(() => null)) as { accion?: unknown; barrio?: unknown } | null;
  if (datos?.accion === 'probar-notificaciones') return probarNotificaciones(contexto);
  if (datos?.accion !== 'limpiar') return Response.json({ error: 'Acción desconocida' }, { status: 400 });
  const barrio = datos.barrio === undefined ? undefined : barrioValido(datos.barrio);
  if (barrio === null) return Response.json({ error: 'Barrio inválido' }, { status: 400 });
  return Response.json({ borrados: await limpiarReportes(contexto.env.DB, barrio) });
}
