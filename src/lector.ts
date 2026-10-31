import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { crearUbicador, type Ubicacion, type ZonaAproximada } from './barrios.ts';
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

const urls = (await buscarNotas()).slice(0, NOTAS_A_LEER);
if (urls.length === 0) console.warn('⚠️  No encontré notas de cortes en el sitemap de El Doce.');

const nuevos: Mantenimiento[] = [];
for (const url of urls) {
  const { mantenimientos, noReconocidas } = parsearNota(await descargar(url), url);
  console.log(`${mantenimientos.length} cortes en capital ← ${url}`);
  for (const renglon of noReconocidas) console.warn(`⚠️  Renglón no reconocido: "${renglon}"`);
  nuevos.push(...mantenimientos);
}

// Ubicamos todos los cortes (también los viejos), así una mejora en los alias corrige el historial.
const mapa = await leerJson<{ features: { properties: { nombre: string | null } }[] }>('data/barrios.geojson');
const zonas = await leerJson<{ features: { properties: ZonaAproximada }[] }>('data/zonas.geojson');
const ubicar = crearUbicador(
  mapa.features.flatMap((f) => f.properties.nombre ?? []),
  await leerJson<Record<string, string | null>>('data/alias-barrios.json'),
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
