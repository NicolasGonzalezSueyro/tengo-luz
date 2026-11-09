import lugares from '../../data/lugares.js';
import { desuscribir, suscribir } from '../../src/notificaciones.ts';
import { clavePublicaDe, suscripcionValida, type ClavePush } from '../../src/push.ts';
import { huellaDe, type BaseDeDatos } from '../../src/reportes.ts';
import { anotarIntento, frenado } from '../../src/freno.ts';

// /api/push: las notificaciones del navegador.
//   GET  → nuestra clave pública (el navegador la necesita para suscribirse).
//   POST { "accion": "agregar" | "quitar", "barrio": "Alberdi", "suscripcion": { endpoint, keys } }
// PUSH_CLAVE (secreto de Cloudflare) es nuestra clave privada; se genera con `npm run claves-push`.

type Contexto = { request: Request; env: { DB: BaseDeDatos; PUSH_CLAVE?: string; CLAVE?: string } };

const LUGARES = new Set(lugares);
// Una casa o un celu son unos pocos navegadores. Alto igual, porque con las compañías de celular muchas
// personas salen a internet con la misma IP.
const NAVEGADORES_POR_HORA = 20;
const sinConfigurar = () => Response.json({ error: 'Las notificaciones todavía no están configuradas.' }, { status: 503 });

export async function onRequestGet({ env }: Contexto) {
  if (!env.PUSH_CLAVE) return sinConfigurar();
  return Response.json({ clavePublica: clavePublicaDe(JSON.parse(env.PUSH_CLAVE) as ClavePush) });
}

export async function onRequestPost({ request, env }: Contexto) {
  if (!env.PUSH_CLAVE) return sinConfigurar();
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return Response.json({ error: 'Se espera JSON' }, { status: 415 });
  const cuerpo = await request.text();
  if (cuerpo.length > 3000) return Response.json({ error: 'Pedido demasiado grande' }, { status: 413 });
  const datos = (() => {
    try {
      return JSON.parse(cuerpo) as { accion?: unknown; barrio?: unknown; suscripcion?: unknown };
    } catch {
      return null;
    }
  })();
  if (!datos || (datos.accion !== 'agregar' && datos.accion !== 'quitar')) return Response.json({ error: 'Acción desconocida' }, { status: 400 });
  if (typeof datos.barrio !== 'string' || !LUGARES.has(datos.barrio)) return Response.json({ error: 'Barrio desconocido' }, { status: 400 });
  if (!suscripcionValida(datos.suscripcion)) return Response.json({ error: 'Suscripción inválida' }, { status: 400 });

  if (datos.accion === 'quitar') {
    await desuscribir(env.DB, datos.suscripcion.endpoint, datos.barrio);
    return Response.json({ resultado: 'listo' });
  }
  // Un navegador nuevo cuenta para el freno: nadie puede llenar la base con miles de suscripciones inventadas.
  // Sumar barrios a un navegador que ya está no cuenta.
  const ahora = Date.now();
  const yaEsta = await env.DB.prepare('SELECT 1 FROM push_suscripciones WHERE endpoint = ? LIMIT 1').bind(datos.suscripcion.endpoint).first();
  const huella = await huellaDe(request.headers.get('CF-Connecting-IP') ?? 'desconocida', env.CLAVE ?? env.PUSH_CLAVE, ahora);
  if (!yaEsta && (await frenado(env.DB, 'push', huella, NAVEGADORES_POR_HORA, 60 * 60 * 1000, ahora))) {
    return Response.json({ error: 'Demasiadas suscripciones desde esta conexión: probá más tarde.' }, { status: 429 });
  }
  const resultado = await suscribir(env.DB, datos.suscripcion, datos.barrio, ahora);
  if (!yaEsta && resultado === 'listo') await anotarIntento(env.DB, 'push', huella, ahora);
  if (resultado === 'demasiados') return Response.json({ error: 'Podés recibir avisos de hasta 10 barrios.' }, { status: 409 });
  return Response.json({ resultado });
}
