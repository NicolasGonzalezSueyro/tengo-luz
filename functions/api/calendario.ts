import { archivoIcs } from '../../web/calendario.js';
import { lugaresDelCorte, type Corte } from '../../web/estado.js';

// /api/calendario?fecha=2026-10-31&desde=08:00&hasta=13:00&lugar=Alberdi → el evento del corte como archivo .ics.
// Tiene que ser una dirección de verdad (no un archivo armado en el navegador) porque así el iPhone abre directo
// "Agregar al calendario". Solo arma eventos de cortes que están en los datos: nadie puede inventar uno.

// ASSETS: los archivos del sitio (Cloudflare lo agrega solo). De ahí se lee data/mantenimientos.json.
type Contexto = { request: Request; env: { ASSETS: { fetch(url: URL): Promise<Response> } } };

export async function onRequestGet({ request, env }: Contexto) {
  const url = new URL(request.url);
  const [fecha, desde, hasta] = ['fecha', 'desde', 'hasta'].map((p) => url.searchParams.get(p) ?? '');
  const lugar = url.searchParams.get('lugar');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(desde) || !/^\d{2}:\d{2}$/.test(hasta)) {
    return new Response('Faltan la fecha o el horario del corte', { status: 400 });
  }

  const cortes = (await (await env.ASSETS.fetch(new URL('/data/mantenimientos.json', url))).json()) as Corte[];
  const corte = cortes.find((c) => c.fecha === fecha && c.desde === desde && c.hasta === hasta && (!lugar || lugaresDelCorte(c).includes(lugar)));
  if (!corte) return new Response('No encontré ese corte', { status: 404 });

  return new Response(archivoIcs(corte, lugar, url.origin), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="corte-de-luz.ics"',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
