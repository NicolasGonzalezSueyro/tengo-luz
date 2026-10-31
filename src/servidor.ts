import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import * as admin from '../functions/api/admin.ts';
import * as calendario from '../functions/api/calendario.ts';
import * as reportes from '../functions/api/reportes.ts';
import * as telegram from '../functions/api/telegram.ts';
import { baseLocal } from './base-local.ts';

// Servidor solo para probar la página en la compu (`npm run dev`).
// Sirve web/ en la raíz y data/ en /data, igual que lo va a hacer el hosting.
// También responde /api/... con las mismas funciones que Cloudflare, pero con una base en memoria
// que se borra al cortar el servidor. (/api/avisar no está: necesita el token real del bot.)

/** Las funciones de functions/api, como las arma Cloudflare: por dirección y por método. */
const API: Record<string, { onRequestGet?: Function; onRequestPost?: Function }> = {
  '/api/admin': admin,
  '/api/calendario': calendario,
  '/api/reportes': reportes,
  '/api/telegram': telegram,
};

const PUERTO = 4321;
const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ics': 'text/calendar; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const entornoDePrueba = {
  DB: baseLocal(),
  CLAVE: 'solo-para-probar',
  SECRETO_BOT: 'solo-para-probar',
  TELEGRAM_ADMIN: '1',
  ADMIN_CLAVE: 'solo-para-probar',
  // Como en Cloudflare: los archivos del sitio. Las funciones solo piden cosas de /data.
  ASSETS: { fetch: async (url: URL) => new Response(await readFile(join(process.cwd(), url.pathname))) },
};

createServer(async (req, res) => {
  const ruta = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);

  if (ruta.startsWith('/api/')) {
    const funciones = API[ruta];
    const manejador = req.method === 'GET' ? funciones?.onRequestGet : req.method === 'POST' ? funciones?.onRequestPost : undefined;
    if (!manejador) {
      res.writeHead(funciones ? 405 : 404).end(funciones ? 'Método no permitido' : 'No encontrado');
      return;
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'POST' ? await text(req) : undefined,
    });
    const respuesta = await manejador({ request, env: entornoDePrueba });
    res.writeHead(respuesta.status, Object.fromEntries(respuesta.headers)).end(await respuesta.text());
    return;
  }

  const [carpeta, relativa] = ruta.startsWith('/data/') ? ['data', ruta.slice('/data/'.length)] : ['web', ruta.slice(1) || 'index.html'];
  const base = join(process.cwd(), carpeta);
  const archivo = normalize(join(base, relativa));
  // Evita que alguien pida "/../../archivo-secreto" y lea algo fuera de estas carpetas.
  if (!archivo.startsWith(base + sep)) {
    res.writeHead(403).end('Prohibido');
    return;
  }
  try {
    const contenido = await readFile(archivo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(archivo)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(contenido);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
}).listen(PUERTO, '127.0.0.1', () => console.log(`Página en http://localhost:${PUERTO}`));
