import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const urls = (await buscarNotas()).slice(0, NOTAS_A_LEER);
if (urls.length === 0) console.warn('⚠️  No encontré notas de cortes en el sitemap de El Doce.');

const nuevos: Mantenimiento[] = [];
for (const url of urls) {
  const { mantenimientos, noReconocidas } = parsearNota(await descargar(url), url);
  console.log(`${mantenimientos.length} cortes en capital ← ${url}`);
  for (const renglon of noReconocidas) console.warn(`⚠️  Renglón no reconocido: "${renglon}"`);
  nuevos.push(...mantenimientos);
}

const todos = unir(await leerGuardados(), nuevos);
await mkdir('data', { recursive: true });
await writeFile(ARCHIVO, JSON.stringify(todos, null, 2) + '\n');
console.log(`Guardados ${todos.length} cortes en ${ARCHIVO}`);
