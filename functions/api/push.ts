import lugares from '../../data/lugares.js';
import { desuscribir, suscribir } from '../../src/notificaciones.ts';
import { clavePublicaDe, suscripcionValida, type ClavePush } from '../../src/push.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';

// /api/push: las notificaciones del navegador.
//   GET  → nuestra clave pública (el navegador la necesita para suscribirse).
//   POST { "accion": "agregar" | "quitar", "barrio": "Alberdi", "suscripcion": { endpoint, keys } }
// PUSH_CLAVE (secreto de Cloudflare) es nuestra clave privada; se genera con `npm run claves-push`.

type Contexto = { request: Request; env: { DB: BaseDeDatos; PUSH_CLAVE?: string } };

const LUGARES = new Set(lugares);
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
  const resultado = await suscribir(env.DB, datos.suscripcion, datos.barrio, Date.now());
  if (resultado === 'demasiados') return Response.json({ error: 'Podés recibir avisos de hasta 10 barrios.' }, { status: 409 });
  return Response.json({ resultado });
}
