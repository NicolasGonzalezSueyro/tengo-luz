import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { momentoEnCordoba } from '../web/estado.js';
import { alertar } from './alertar.ts';
import { crearUbicador, esDescripcion, normalizar, type Ubicacion, type ZonaAproximada } from './barrios.ts';
import { buscarNotas, descargar, parsearNota } from './fuentes/eldoce.ts';
import { unir, type Mantenimiento } from './mantenimiento.ts';

const ARCHIVO = 'data/mantenimientos.json';
// Leemos las últimas notas por si alguna corrida anterior falló o la nota se actualizó.
const NOTAS_A_LEER = 3;

async function leerGuardados(): Promise<Mantenimiento[]> {
  try {
    return JSON.parse(await readFile(ARCHIVO, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // primera vez: todavía no hay archivo
    throw error;
  }
}

async function leerJson<T>(archivo: string): Promise<T> {
  return JSON.parse(await readFile(archivo, 'utf8'));
}

// Lo que haya que revisar a mano: al final se manda por Telegram al admin (src/alertar.ts).
const alertas: { texto: string; detalle?: string }[] = [];

// Si no se puede leer el sitemap, el lector se corta (no hay nada que hacer) y GitHub Actions avisa de la falla.
const urls = (await buscarNotas()).slice(0, NOTAS_A_LEER);
if (urls.length === 0) {
  // El sitemap de noticias solo muestra los últimos ~2 días: sin notas, El Doce no publica hace 2 días o cambió el link.
  alertas.push({ texto: 'No encontré notas de cortes de El Doce en los últimos 2 días. ¿Dejaron de publicarlas o cambiaron el link?' });
}

const nuevos: Mantenimiento[] = [];
for (const url of urls) {
  // Una nota rara no frena a las demás: se avisa y se sigue.
  try {
    const { mantenimientos, noReconocidas } = parsearNota(await descargar(url), url);
    console.log(`${mantenimientos.length} cortes en capital ← ${url}`);
    if (noReconocidas.length > 0) {
      alertas.push({ texto: `Hay renglones de cortes que no entendí:\n${noReconocidas.map((r) => `• ${r}`).join('\n')}`, detalle: url });
    }
    nuevos.push(...mantenimientos);
  } catch (error) {
    alertas.push({ texto: `No pude leer una nota de cortes de El Doce: ${(error as Error).message}`, detalle: url });
  }
}

// Ubicamos todos los cortes (también los viejos), así una mejora en los alias corrige el historial.
const mapa = await leerJson<{ features: { properties: { nombre: string | null } }[] }>('data/barrios.geojson');
const zonas = await leerJson<{ features: { properties: ZonaAproximada }[] }>('data/zonas.geojson');
const alias = await leerJson<Record<string, string | null>>('data/alias-barrios.json');
const ubicar = crearUbicador(
  mapa.features.flatMap((f) => f.properties.nombre ?? []),
  alias,
  zonas.features.map((f) => f.properties),
);
const todos: (Mantenimiento & Ubicacion)[] = unir(await leerGuardados(), nuevos).map((m) => ({ ...m, ...ubicar(m.zona) }));

await mkdir('data', { recursive: true });
await writeFile(ARCHIVO, JSON.stringify(todos, null, 2) + '\n');
console.log(`Guardados ${todos.length} cortes en ${ARCHIVO}`);

const sinUbicar = [...new Set(todos.flatMap((m) => m.sinUbicar))];
const enElMapa = todos.filter((m) => m.barrios.length > 0 || m.zonas.length > 0).length;
console.log(`📍 ${enElMapa} de ${todos.length} cortes se pueden marcar en el mapa (por barrio o zona aproximada).`);
if (sinUbicar.length) console.log(`❓ Sin ubicar (se pueden agregar a data/alias-barrios.json):\n   - ${sinUbicar.join('\n   - ')}`);

// Barrios de cortes que vienen y que no conocemos. No cuentan las descripciones de calles ni los alias en null
// (los que decidimos no ubicar a propósito).
const ignorados = new Set(Object.keys(alias).filter((nombre) => alias[nombre] === null).map(normalizar));
const desconocidos = [
  ...new Set(todos.filter((m) => m.fecha >= momentoEnCordoba().fecha).flatMap((m) => m.sinUbicar)),
].filter((texto) => !esDescripcion(texto) && !ignorados.has(texto));
if (desconocidos.length > 0) {
  alertas.push({
    texto: `Hay barrios de cortes que vienen que no pude ubicar en el mapa:\n${desconocidos.map((d) => `• ${d}`).join('\n')}`,
    detalle: 'Se agregan en data/alias-barrios.json',
  });
}

for (const { texto, detalle } of alertas) await alertar(texto, detalle);
