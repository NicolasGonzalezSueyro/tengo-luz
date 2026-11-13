import { cortesValidos, leerFoto, pedirQueCorraElRobot, recibirFoto } from '../../src/fuentes/epec.ts';
import type { BaseDeDatos } from '../../src/reportes.ts';
import { revisarClave } from '../../src/seguridad.ts';
import { enviarMensaje } from '../../src/telegram.ts';
import { momentoEnCordoba } from '../../web/estado.js';

// /api/cortes-epec: los cortes programados de EPEC (src/fuentes/epec.ts).
//   POST → un servicio externo manda la foto completa de lo publicado (hoy, mañana y pasado): un array de cortes,
//          o { "cortes": [ … ] }. Reemplaza la foto anterior.
//   GET  → el robot de GitHub lee la última foto para armar data/mantenimientos.json.
// Las dos piden "Authorization: Bearer <EPEC_OFICIAL_KEY>" (secreto de Cloudflare), con freno a los intentos fallidos.
// Si la foto cambió y está el secreto GITHUB_TOKEN, se le pide a GitHub que corra el robot ya (sin esperar al horario).

type Contexto = {
  request: Request;
  env: { DB: BaseDeDatos; EPEC_OFICIAL_KEY?: string; GITHUB_TOKEN?: string; TELEGRAM_TOKEN?: string; TELEGRAM_ADMIN?: string };
  waitUntil?: (tarea: Promise<unknown>) => void;
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
  const { env } = contexto;
  const foto = await recibirFoto(env.DB, cortes, Date.now(), momentoEnCordoba());
  if (foto !== 'guardada') {
    // La primera vez se le avisa al admin: puede ser que el servicio que lee a EPEC esté fallando.
    if (foto === 'en espera' && env.TELEGRAM_TOKEN && env.TELEGRAM_ADMIN) {
      const aviso = enviarMensaje(env.TELEGRAM_TOKEN, Number(env.TELEGRAM_ADMIN),
        `🛠️ Llegó una foto de EPEC con ${cortes.length} cortes, y le faltan más de la mitad de los que estaban por venir. No la apliqué: si la próxima viene igual, la acepto. Revisá que el lector de EPEC ande bien.`)
        .catch((e) => console.error('No se pudo avisar al admin', e));
      if (contexto.waitUntil) contexto.waitUntil(aviso);
      else await aviso; // en los tests no hay waitUntil
    }
    return Response.json({ guardados: 0, enEspera: cortes.length, robot: 'sin cambios' });
  }
  const robot = env.GITHUB_TOKEN ? await pedirQueCorraElRobot(env.DB, cortes, env.GITHUB_TOKEN, Date.now()) : 'sin token';
  return Response.json({ guardados: cortes.length, robot });
}

export async function onRequestGet(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const foto = await leerFoto(contexto.env.DB);
  return Response.json(foto ?? { recibido: 0, cortes: [] }, { headers: { 'Cache-Control': 'no-store' } });
}
