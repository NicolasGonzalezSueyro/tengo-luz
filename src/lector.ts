import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { barrioEnPunto, momentoEnCordoba } from '../web/estado.js';
import { alertar } from './alertar.ts';
import {
  centro, crearUbicador, encabezadoDelCorte, esDescripcion, localidadesQueNombra, lugaresSeparados, normalizar, type Punto, type Ubicacion, type ZonaAproximada,
} from './barrios.ts';
import { buscarNotas, descargar, parsearNota } from './fuentes/eldoce.ts';
import { sectorDelCorte, type Caja } from './sectores.ts';
import { CAPITAL, unir, type Mantenimiento } from './mantenimiento.ts';

const ARCHIVO = 'data/mantenimientos.json';
// Leemos las últimas notas por si alguna corrida anterior falló o la nota se actualizó.
const NOTAS_A_LEER = 3;

async function leerGuardados(): Promise<Mantenimiento[]> {
  try {
    // Los cortes guardados antes de ampliar a Gran Córdoba no tienen localidad: eran todos de capital.
    return (JSON.parse(await readFile(ARCHIVO, 'utf8')) as Mantenimiento[]).map((m) => ({ ...m, localidad: m.localidad ?? CAPITAL }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // primera vez: todavía no hay archivo
    throw error;
  }
}

async function leerJson<T>(archivo: string): Promise<T> {
  return JSON.parse(await readFile(archivo, 'utf8'));
}

/** La caja [sur, oeste, norte, este] que encierra a todas las geometrías, agrandada `margen` grados. */
function cajaDe(features: { geometry: { coordinates: unknown } }[], margen: number): Caja {
  const puntos = features.flatMap((f) => (f.geometry.coordinates as unknown[]).flat(3) as number[]);
  const lons = puntos.filter((_, i) => i % 2 === 0);
  const lats = puntos.filter((_, i) => i % 2 === 1);
  return [Math.min(...lats) - margen, Math.min(...lons) - margen, Math.max(...lats) + margen, Math.max(...lons) + margen];
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
    console.log(`${mantenimientos.filter((m) => m.localidad === CAPITAL).length} cortes en capital y ${mantenimientos.length} en total ← ${url}`);
    if (noReconocidas.length > 0) {
      alertas.push({ texto: `Hay renglones de cortes que no entendí:\n${noReconocidas.map((r) => `• ${r}`).join('\n')}`, detalle: url });
    }
    nuevos.push(...mantenimientos);
  } catch (error) {
    alertas.push({ texto: `No pude leer una nota de cortes de El Doce: ${(error as Error).message}`, detalle: url });
  }
}

// Ubicamos todos los cortes (también los viejos), así una mejora en los alias corrige el historial.
type Geometria = { type: string; coordinates: unknown };
const mapa = await leerJson<{ features: { properties: { nombre: string | null }; geometry: Geometria }[] }>('data/barrios.geojson');
const zonas = await leerJson<{ features: { properties: ZonaAproximada; geometry: Geometria }[] }>('data/zonas.geojson');
const alias = await leerJson<Record<string, string | null>>('data/alias-barrios.json');
const localidades = zonas.features.map((f) => f.properties).filter((z) => z.tipo === 'localidad');
const ubicar = crearUbicador(
  mapa.features.flatMap((f) => f.properties.nombre ?? []),
  alias,
  zonas.features.map((f) => f.properties).filter((z) => z.tipo !== 'localidad'),
);

/**
 * Capital se ubica por barrios (y rutas). Fuera de capital solo se buscan las localidades de Gran Córdoba,
 * y nunca barrios de capital: un "barrio Don Bosco" de Alta Gracia no tiene que pintar uno de capital.
 */
const ubicarCorte = (m: Mantenimiento): Ubicacion =>
  m.localidad === CAPITAL
    ? ubicar(m.zona)
    : { barrios: [], zonas: localidadesQueNombra(encabezadoDelCorte(m.localidad, m.zona), localidades), sinUbicar: [] };

const todos: (Mantenimiento & Ubicacion & { sector?: Punto[] })[] = unir(await leerGuardados(), nuevos)
  .map((m) => ({ ...m, ...ubicarCorte(m) }))
  // De fuera de capital, solo los cortes de Gran Córdoba (el resto de la provincia no está en el mapa).
  .filter((m) => m.localidad === CAPITAL || m.zonas.length > 0);

// Sectores exactos (src/sectores.ts) para los cortes descriptos por calles o lugares. Cada uno se busca en
// OpenStreetMap una sola vez y queda guardado en data/sectores.json (null = no se pudo armar: se marca la zona entera).
const SECTORES = 'data/sectores.json';
const sectoresGuardados = await leerJson<Record<string, Punto[] | null>>(SECTORES).catch(() => ({}) as Record<string, Punto[] | null>);
const sectores: Record<string, Punto[] | null> = {};
const porNombre = (features: { properties: { nombre: string | null }; geometry: Geometria }[], nombres: string[]) =>
  features.filter((f) => f.properties.nombre && nombres.includes(f.properties.nombre));

/** Dónde buscar el sector: la localidad (si es una sola), o los barrios del corte en capital si el texto nombra calles. */
function zonaDeBusqueda(m: Mantenimiento & Ubicacion) {
  if (m.localidad !== CAPITAL) return m.zonas.length === 1 ? porNombre(zonas.features, m.zonas) : [];
  return m.barrios.length > 0 && m.sinUbicar.some(esDescripcion) ? porNombre(mapa.features, m.barrios) : [];
}

for (const m of todos) {
  const zona = zonaDeBusqueda(m);
  if (zona.length === 0) continue;
  const clave = `${m.localidad}|${m.zona}`;
  if (!(clave in sectores)) {
    if (clave in sectoresGuardados) {
      sectores[clave] = sectoresGuardados[clave];
    } else {
      try {
        // En capital las calles nombradas suelen ser el borde del barrio, así que sus esquinas caen justo en el límite:
        // se busca en la caja del barrio agrandada (~400 m). En las localidades sí se exige estar dentro del municipio,
        // porque un mismo corte puede nombrar barrios de pueblos vecinos.
        const enCapital = m.localidad === CAPITAL;
        sectores[clave] = await sectorDelCorte(
          m.zona,
          cajaDe(zona, enCapital ? 0.004 : 0),
          enCapital ? undefined : (p) => barrioEnPunto(zona, p) !== null,
          { conBarrios: !enCapital },
        );
        console.log(`🧭 Sector de "${m.zona.slice(0, 60)}…": ${sectores[clave] ? 'armado' : 'no se pudo, se marca la zona entera'}`);
        await new Promise((listo) => setTimeout(listo, 2000)); // sin apurar a Overpass, que es gratuito y compartido
      } catch (error) {
        // Sin conexión con OpenStreetMap: no se guarda nada y se vuelve a intentar en la próxima corrida.
        console.warn(`⚠️  No pude buscar el sector de "${m.zona.slice(0, 60)}…": ${(error as Error).message}`);
        continue;
      }
    }
  }
  const sector = sectores[clave];
  if (sector) m.sector = sector;
}

await mkdir('data', { recursive: true });
// Solo quedan los sectores de los cortes guardados: el archivo no crece para siempre.
await writeFile(SECTORES, JSON.stringify(sectores) + '\n');
await writeFile(ARCHIVO, JSON.stringify(todos, null, 2) + '\n');
console.log(`Guardados ${todos.length} cortes en ${ARCHIVO}`);

const sinUbicar = [...new Set(todos.flatMap((m) => m.sinUbicar))];
const enElMapa = todos.filter((m) => m.barrios.length > 0 || m.zonas.length > 0).length;
console.log(`📍 ${enElMapa} de ${todos.length} cortes se pueden marcar en el mapa (por barrio o zona aproximada).`);
if (sinUbicar.length) console.log(`❓ Sin ubicar (se pueden agregar a data/alias-barrios.json):\n   - ${sinUbicar.join('\n   - ')}`);

// Barrios de cortes que vienen y que no conocemos. No cuentan las descripciones de calles ni los alias en null
// (los que decidimos no ubicar a propósito).
const ignorados = new Set(Object.keys(alias).filter((nombre) => alias[nombre] === null).map(normalizar));
const queVienen = todos.filter((m) => m.fecha >= momentoEnCordoba().fecha);
const desconocidos = [...new Set(queVienen.flatMap((m) => m.sinUbicar))].filter((texto) => !esDescripcion(texto) && !ignorados.has(texto));
if (desconocidos.length > 0) {
  alertas.push({
    texto: `Hay barrios de cortes que vienen que no pude ubicar en el mapa:\n${desconocidos.map((d) => `• ${d}`).join('\n')}`,
    detalle: 'Se agregan en data/alias-barrios.json',
  });
}

// Barrios de un mismo corte muy separados: seguramente un nombre repetido se ubicó en el lugar equivocado.
const centros = new Map(
  [...mapa.features, ...zonas.features].flatMap((f): [string, Punto][] => (f.properties.nombre ? [[f.properties.nombre, centro(f.geometry)]] : [])),
);
// Solo en capital: un renglón de "Otras localidades" puede nombrar pueblos lejanos entre sí, y está bien.
for (const m of queVienen.filter((c) => c.localidad === CAPITAL)) {
  const separados = lugaresSeparados([...m.barrios, ...m.zonas], centros);
  if (separados) {
    alertas.push({
      texto: `Revisá un corte del ${m.fecha} (${m.desde} a ${m.hasta}): ${separados.a} y ${separados.b} quedan a ${Math.round(separados.km)} km. ¿Algún barrio se ubicó en el lugar equivocado?`,
      detalle: `${m.zona}\n${m.fuente}`,
    });
  }
}

for (const { texto, detalle } of alertas) await alertar(texto, detalle);
