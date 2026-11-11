import { cortesValidos, guardarFoto, leerFoto, pedirQueCorraElRobot } from '../../src/fuentes/epec.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { revisarClave } from '../../src/seguridad.ts';

// /api/cortes-epec: los cortes programados de EPEC (src/fuentes/epec.ts).
//   POST → un servicio externo manda la foto completa de lo publicado (hoy, mañana y pasado): un array de cortes,
//          o { "cortes": [ … ] }. Reemplaza la foto anterior.
//   GET  → el robot de GitHub lee la última foto para armar data/mantenimientos.json.
// Las dos piden "Authorization: Bearer <EPEC_OFICIAL_KEY>" (secreto de Cloudflare), con freno a los intentos fallidos.
// Si la foto cambió y está el secreto GITHUB_TOKEN, se le pide a GitHub que corra el robot ya (sin esperar al horario).

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; EPEC_OFICIAL_KEY?: string; GITHUB_TOKEN?: string };
};

async function rechazar({ request, env }: Contexto) {
  if (!env.EPEC_OFICIAL_KEY) return Response.json({ error: 'Falta configurar EPEC_OFICIAL_KEY en Cloudflare' }, { status: 503 });
  const resultado = await revisarClave(request, env.EPEC_OFICIAL_KEY, env.DB, env.EPEC_OFICIAL_KEY);
  if (resultado === 'bloqueado') return Response.json({ error: 'Demasiados intentos: probá de nuevo en 15 minutos' }, { status: 429 });
  if (resultado === 'mala') return Response.json({ error: 'Clave incorrecta' }, { status: 401 });
  return null;
}

export async function onRequestPost(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const cuerpo = await contexto.request.text();
  if (cuerpo.length > 500_000) return Response.json({ error: 'Pedido demasiado grande' }, { status: 413 });
  const datos = (() => {
    try {
      return JSON.parse(cuerpo) as unknown;
    } catch {
      return null;
    }
  })();
  const cortes = cortesValidos(datos);
  if (typeof cortes === 'string') return Response.json({ error: cortes }, { status: 400 });
  await guardarFoto(contexto.env.DB, cortes, Date.now());
  const robot = contexto.env.GITHUB_TOKEN ? await pedirQueCorraElRobot(contexto.env.DB, cortes, contexto.env.GITHUB_TOKEN, Date.now()) : 'sin token';
  return Response.json({ guardados: cortes.length, robot });
}

export async function onRequestGet(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const foto = await leerFoto(contexto.env.DB);
  return Response.json(foto ?? { recibido: 0, cortes: [] }, { headers: { 'Cache-Control': 'no-store' } });
}
