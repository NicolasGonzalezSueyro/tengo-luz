import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

// Servidor solo para probar la página en la compu (`npm run dev`).
// Sirve web/ en la raíz y data/ en /data, igual que lo va a hacer el hosting.

const PUERTO = 4321;
const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const ruta = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
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
