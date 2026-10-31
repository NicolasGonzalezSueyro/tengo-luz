import { estadisticas, limpiarReportes } from '../../src/admin.ts';
import { barrioValido, type BaseDeDatos } from '../../src/reportes.ts';

// La API del panel de admin (web/admin.html). Pide la clave ADMIN_CLAVE, que se configura en Cloudflare.
//   GET  /api/admin → números del sitio, reportes vigentes y barrios más seguidos.
//   POST /api/admin { "accion": "limpiar", "barrio": "Alberdi" } → borra reportes (de un barrio, o todos sin "barrio").

type Contexto = { request: Request; env: { DB: BaseDeDatos; ADMIN_CLAVE?: string } };

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

export async function onRequestPost(contexto: Contexto) {
  const error = await rechazar(contexto);
  if (error) return error;
  const datos = (await contexto.request.json().catch(() => null)) as { accion?: unknown; barrio?: unknown } | null;
  if (datos?.accion !== 'limpiar') return Response.json({ error: 'Acción desconocida' }, { status: 400 });
  const barrio = datos.barrio === undefined ? undefined : barrioValido(datos.barrio);
  if (barrio === null) return Response.json({ error: 'Barrio inválido' }, { status: 400 });
  return Response.json({ borrados: await limpiarReportes(contexto.env.DB, barrio) });
}
