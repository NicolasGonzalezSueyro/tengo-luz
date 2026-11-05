// Editor de contornos (npm run editor): una página en la compu para corregir a mano el contorno de cualquier lugar
// del mapa, o dibujar uno nuevo. Al guardar:
// - el contorno queda en data/contornos-manuales.geojson (junto con el original, para poder volver atrás),
// - se aplica al mapa que corresponda (barrios, zonas o barrios-interior) y se regenera data/lugares.js.
// Solo escucha en la propia compu (127.0.0.1): nadie de afuera puede cambiar nada.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { aplicarContornos, ARCHIVO_MANUALES, contornoValido, leerManuales, type ContornoManual, type Destino } from './contornos.ts';
import { escribirLugares } from './lugares.ts';

const PUERTO = Number(process.env.PUERTO ?? 4400);
const ARCHIVOS: Record<Destino, string> = { barrios: 'data/barrios.geojson', zonas: 'data/zonas.geojson', interior: 'data/barrios-interior.geojson' };
const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
};

type Coleccion = { type: string; features: { properties: Record<string, unknown> & { nombre?: string | null }; geometry: { type: string } }[] };
const leerMapa = async (destino: Destino) => JSON.parse(await readFile(ARCHIVOS[destino], 'utf8')) as Coleccion;
const guardarMapa = (destino: Destino, c: Coleccion) =>
  writeFile(ARCHIVOS[destino], (destino === 'zonas' ? JSON.stringify(c, null, 1) : JSON.stringify(c)) + '\n');

type Pedido = { nombre?: unknown; destino?: unknown; localidad?: unknown; geometria?: unknown; restaurar?: unknown };

/** Guarda (o deshace) un contorno manual. Devuelve un mensaje para mostrar, o tira un error si el pedido no sirve. */
async function guardar(pedido: Pedido): Promise<string> {
  const nombre = typeof pedido.nombre === 'string' ? pedido.nombre.trim() : '';
  const destino = pedido.destino as Destino;
  if (!nombre || nombre.length > 120) throw new Error('Falta el nombre del lugar (hasta 120 letras).');
  if (!(destino in ARCHIVOS)) throw new Error('No sé en qué mapa va ese lugar.');
  const localidad = typeof pedido.localidad === 'string' && pedido.localidad.trim() ? pedido.localidad.trim().slice(0, 80) : undefined;

  const manuales = leerManuales();
  const anterior = manuales.find((m) => m.properties.nombre === nombre && m.properties.destino === destino);
  const mapa = await leerMapa(destino);
  const otros = manuales.filter((m) => m !== anterior);

  if (pedido.restaurar) {
    if (!anterior) return `${nombre} ya tenía su contorno original.`;
    const original = anterior.properties.original;
    const antes = anterior.properties.antes ?? {};
    const restaurar = (f: Coleccion['features'][number]) => {
      f.geometry = original!;
      for (const clave of ['fuente', 'tipo', 'contorno']) {
        if (antes[clave] === undefined) delete f.properties[clave];
        else f.properties[clave] = antes[clave];
      }
    };
    if (original) mapa.features.filter((f) => f.properties.nombre === nombre).forEach(restaurar);
    else mapa.features = mapa.features.filter((f) => f.properties.nombre !== nombre); // era un lugar nuevo
    await escribir(otros, destino, mapa);
    return `Listo: ${nombre} volvió a su contorno original.`;
  }

  if (!contornoValido(pedido.geometria)) throw new Error('El contorno tiene que ser un polígono dentro de la provincia (hasta 5000 puntos).');
  // El original se guarda la primera vez, para poder volver atrás (null si es un lugar nuevo o era un punto).
  const actual = mapa.features.find((f) => f.properties.nombre === nombre && /Polygon$/.test(f.geometry.type));
  const original = anterior ? anterior.properties.original : ((actual?.geometry as ContornoManual['properties']['original']) ?? null);
  const antes = anterior ? anterior.properties.antes
    : actual && { fuente: actual.properties.fuente, tipo: actual.properties.tipo, contorno: actual.properties.contorno };
  const nuevo: ContornoManual = {
    type: 'Feature', properties: { nombre, destino, ...(localidad ? { localidad } : {}), original, ...(antes ? { antes } : {}) }, geometry: pedido.geometria,
  };
  await escribir([...otros, nuevo], destino, mapa);
  return `Guardado el contorno de ${nombre}.`;
}

async function escribir(manuales: ContornoManual[], destino: Destino, mapa: Coleccion) {
  await writeFile(ARCHIVO_MANUALES, JSON.stringify({ type: 'FeatureCollection', features: manuales }) + '\n');
  await guardarMapa(destino, aplicarContornos(mapa, destino, manuales));
  escribirLugares();
}

createServer(async (req, res) => {
  const ruta = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (ruta === '/guardar' && req.method === 'POST') {
    try {
      const mensaje = await guardar(JSON.parse(await text(req)) as Pedido);
      console.log(mensaje);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ mensaje }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }
  const [carpeta, relativa] = ruta.startsWith('/data/') ? ['data', ruta.slice('/data/'.length)] : ['herramientas', ruta.slice(1) || 'editor.html'];
  const base = join(process.cwd(), carpeta);
  const archivo = normalize(join(base, relativa));
  if (!archivo.startsWith(base + sep)) {
    res.writeHead(403).end('Prohibido');
    return;
  }
  try {
    const contenido = await readFile(archivo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(archivo)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(contenido);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
}).listen(PUERTO, '127.0.0.1', () => console.log(`✏️  Editor de contornos en http://localhost:${PUERTO}`));
