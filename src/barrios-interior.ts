// Los barrios de las localidades del interior y el casco urbano de cada una (npm run barrios-interior).
//
// Para cada localidad del mapa (data/zonas.geojson, tipo "localidad"):
// 1. Baja de OpenStreetMap sus barrios (con contorno o como punto) y el uso del suelo (residencial, comercial…).
// 2. Arma el casco urbano: la parte con casas, sin el campo que suele incluir el ejido municipal. Un corte de
//    "toda la localidad" pinta solo esto.
//    Si el municipio publica sus barrios oficiales en Mapas Córdoba (IDECOR, Provincia), se usan esos primero.
// 3. Busca en Nominatim, dentro de la localidad, los barrios que nombra EPEC y no aparecieron en el paso 1.
// 4. A los que solo tienen ubicación (un punto) les da un contorno APROXIMADO: el área alrededor del punto,
//    repartida con los barrios vecinos (Voronoi), recortada al casco y con un tamaño máximo. Nunca un pueblo entero.
//
// Escribe data/barrios-interior.geojson y reemplaza el contorno de cada localidad por su casco urbano.
// Lo que baja queda en .cache/ (no se sube al repo), así se puede volver a correr sin repetir pedidos.
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import type { Feature, MultiPoint, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { normalizar } from './barrios.ts';
import { redondear } from './descargar-zonas.ts';
import { crearUbicadorDeLocalidades, tramosDelCorte, type Candidato, type Localidad } from './localidades.ts';
import { claveDeBarrio, nombresDelTramo } from './nombres.ts';
import { aplicarContornos } from './contornos.ts';

// Overpass: los dos servidores que están detrás de overpass-api.de (su balanceador a veces responde 502 aunque
// ellos anden). Una consulta a la vez en cada uno, como piden (2 por conexión), con mucha paciencia ante los errores.
export const SERVIDORES = ['https://gall.openstreetmap.de/api/interpreter', 'https://lambert.openstreetmap.de/api/interpreter'];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };
const CACHE = '.cache/barrios-interior';
const pausa = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

export type Area = Feature<Polygon | MultiPolygon>;
/** Una localidad de data/zonas.geojson vista como área de GeoJSON (para Turf). */
const comoArea = (l: Localidad) => l as unknown as Area;
export type BarrioInterior = Feature<Polygon | MultiPolygon, {
  nombre: string; // "Centro (Villa María)": único en todo el mapa
  base: string; // "Centro": como lo escribe EPEC
  localidad: string;
  tipo: 'poligono' | 'aproximado';
  fuente: 'osm' | 'nominatim' | 'municipio';
}>;

// ---------------------------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------------------------

export type ElementoOsm = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
};

/** El rectángulo de la localidad para Overpass (sur, oeste, norte, este): mucho más liviano que su límite exacto. */
function caja(localidad: Localidad): string {
  const [oeste, sur, este, norte] = turf.bbox(turf.buffer(comoArea(localidad), 0.3, { units: 'kilometers' })!);
  return [sur, oeste, norte, este].map((n) => n.toFixed(5)).join(',');
}

/** Una consulta a Overpass, reintentando con calma si está ocupado. */
export async function consultarOverpass(consulta: string, nombre: string, servidor: string): Promise<ElementoOsm[]> {
  for (let intento = 1; ; intento++) {
    // Los primeros intentos en su servidor; los siguientes, alternando con el otro.
    const url = intento <= 2 || intento % 2 === 1 ? servidor : SERVIDORES.find((x) => x !== servidor)!;
    const res = await fetch(url, {
      method: 'POST', body: new URLSearchParams({ data: consulta }), headers: IDENTIFICACION, signal: AbortSignal.timeout(200_000),
    }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message }) as Response);
    if (res.ok) return ((await res.json()) as { elements: ElementoOsm[] }).elements;
    if (intento === 8) throw new Error(`Overpass respondió ${res.status} para ${nombre}`);
    const espera = Math.min(120, intento * 30);
    console.warn(`  ${nombre}: Overpass respondió ${res.status}, reintento en ${espera} s…`);
    await pausa(espera * 1000);
  }
}

/** Barrios con nombre y uso del suelo de una localidad, con un caché en disco. */
async function bajarOsm(localidad: Localidad, servidor: string): Promise<ElementoOsm[]> {
  const archivo = `${CACHE}/osm-${normalizar(localidad.properties.nombre).replace(/\s+/g, '-')}.json`;
  const guardado = await readFile(archivo, 'utf8').catch(() => null);
  if (guardado) return JSON.parse(guardado);
  const r = caja(localidad);
  const nombre = localidad.properties.nombre;
  // Dos consultas chicas en vez de una grande: los barrios con nombre, y el uso del suelo (para el casco urbano).
  const barrios = await consultarOverpass(`[out:json][timeout:120];(
    nwr["place"~"^(suburb|neighbourhood|quarter|hamlet|isolated_dwelling|locality)$"]["name"](${r});
    nwr["landuse"="residential"]["name"](${r});
    relation["boundary"="administrative"]["admin_level"~"^(9|10)$"]["name"](${r});
  );out geom qt;`, nombre, servidor);
  await pausa(2000);
  const usos = await consultarOverpass(`[out:json][timeout:120];(
    nwr["landuse"~"^(residential|commercial|retail|industrial)$"](${r});
    way["highway"~"^(residential|living_street)$"](${r});
  );out geom qt;`, nombre, servidor);
  const vistos = new Set<string>();
  const elementos = [...barrios, ...usos].filter((e) => !vistos.has(`${e.type}${e.id}`) && vistos.add(`${e.type}${e.id}`));
  await writeFile(archivo, JSON.stringify(elementos));
  return elementos;
}

const punto = (p: { lat: number; lon: number }): Position => [p.lon, p.lat];
const cerrado = (anillo: Position[]) =>
  anillo.length > 3 && anillo[0][0] === anillo.at(-1)![0] && anillo[0][1] === anillo.at(-1)![1];

/** Une los tramos de las relaciones (cada "way" es un pedazo del borde) en anillos cerrados. */
export function unirAnillos(tramos: Position[][]): Position[][] {
  const pendientes = tramos.filter((t) => t.length >= 2).map((t) => [...t]);
  const anillos: Position[][] = [];
  const igual = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
  while (pendientes.length > 0) {
    const anillo = pendientes.shift()!;
    let avanzo = true;
    while (!cerrado(anillo) && avanzo) {
      avanzo = false;
      for (let i = 0; i < pendientes.length; i++) {
        const t = pendientes[i];
        const fin = anillo.at(-1)!;
        if (igual(t[0], fin)) anillo.push(...t.slice(1));
        else if (igual(t.at(-1)!, fin)) anillo.push(...[...t].reverse().slice(1));
        else continue;
        pendientes.splice(i, 1);
        avanzo = true;
        break;
      }
    }
    if (cerrado(anillo)) anillos.push(anillo);
  }
  return anillos;
}

/** El área de un elemento de OSM (un "way" cerrado o una relación), o null si no es un área. */
export function areaDe(e: ElementoOsm): Area | null {
  try {
    if (e.type === 'way' && e.geometry) {
      const anillo = e.geometry.map(punto);
      return cerrado(anillo) ? turf.polygon([anillo]) : null;
    }
    if (e.type === 'relation' && e.members) {
      const externos = unirAnillos(e.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry!.map(punto)));
      if (externos.length === 0) return null;
      return externos.length === 1 ? turf.polygon([externos[0]]) : turf.multiPolygon(externos.map((a) => [a]));
    }
  } catch {
    // Geometría rota en OSM (anillos que se cruzan, etc.): se ignora.
  }
  return null;
}

/** Une muchas áreas en una. */
export function unir(areas: Area[]): Area | null {
  if (areas.length === 0) return null;
  if (areas.length === 1) return areas[0];
  try {
    return turf.union(turf.featureCollection(areas)) as Area | null;
  } catch {
    // Si alguna geometría está rota, se unen de a una, salteando las que fallan.
    let acumulado: Area | null = null;
    for (const a of areas) {
      try {
        acumulado = acumulado ? (turf.union(turf.featureCollection([acumulado, a])) as Area | null) : a;
      } catch {
        // geometría inválida: se saltea
      }
    }
    return acumulado;
  }
}

export const interseccion = (a: Area, b: Area): Area | null => {
  try {
    return turf.intersect(turf.featureCollection([a, b])) as Area | null;
  } catch {
    return null;
  }
};
export const diferencia = (a: Area, b: Area): Area | null => {
  try {
    return turf.difference(turf.featureCollection([a, b])) as Area | null;
  } catch {
    return a;
  }
};
export const km2 = (a: Area) => turf.area(a) / 1_000_000;

// ---------------------------------------------------------------------------------------------
// Barrios oficiales de los municipios (Mapas Córdoba, IDECOR)
// ---------------------------------------------------------------------------------------------

// El geoportal de la Provincia publica, para algunos municipios, su capa oficial de barrios (servicio WFS, sin
// costo ni restricciones de acceso). Capa y campo del nombre de cada una.
const IDECOR = 'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs';
export const BARRIOS_OFICIALES: Record<string, { capa: string; campo: string }> = {
  'Anisacate': { capa: 'anisacate_barrios', campo: 'nombre' },
  'Colonia Caroya': { capa: 'ccaroya_barrios', campo: 'nombre' },
  'Corralito': { capa: 'corralito_barrios', campo: 'nombre' },
  'Cosquín': { capa: 'cosquin_barrios', campo: 'nombre' },
  'Cruz Alta': { capa: 'cruzalta_barrios', campo: 'name' },
  'Hernando': { capa: 'hernando_barrios', campo: 'nombre' },
  'Jesús María': { capa: 'Jesus_Maria_Barrios', campo: 'barrios' },
  'La Falda': { capa: 'barrios_lf', campo: 'nombre_bar' },
  'Morteros': { capa: 'mteros_barrios', campo: 'name' },
  'Río Cuarto': { capa: 'riocuarto_vecinales', campo: 'nombre' },
  'Salsipuedes': { capa: 'barrios_salsipuedes', campo: 'nombre' },
  'Unquillo': { capa: 'unq_barrios', campo: 'nombre' },
  'Villa Allende': { capa: 'va_barrios', campo: 'nombre' },
  'Villa Giardino': { capa: 'Villa_Giardino_Barrios', campo: 'nombre' },
  'Villa María': { capa: 'vm_barrios', campo: 'nombre' },
};

const CONECTORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
/** "VILLA DEL LAGO (EX LOTEO)" → "Villa del Lago": las capas vienen en mayúsculas y con aclaraciones entre paréntesis. */
export function enTitulo(nombre: string): string {
  const limpio = nombre.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (limpio !== limpio.toUpperCase()) return limpio; // ya viene bien escrito
  return limpio.toLowerCase().split(' ').map((p, i) => {
    if (/^(i|ii|iii|iv|v|vi)$/.test(p)) return p.toUpperCase();
    if (i > 0 && CONECTORES.has(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' ');
}

/** Los barrios oficiales de una localidad (con caché en disco), o ninguno si su municipio no los publica. */
async function bajarBarriosOficiales(localidad: Localidad): Promise<{ base: string; area: Area }[]> {
  const fuente = BARRIOS_OFICIALES[localidad.properties.nombre];
  if (!fuente) return [];
  const archivo = `${CACHE}/idecor-${fuente.capa}.json`;
  let datos = JSON.parse(await readFile(archivo, 'utf8').catch(() => 'null')) as { features: Feature<Polygon | MultiPolygon, Record<string, unknown>>[] } | null;
  if (!datos) {
    const url = new URL(IDECOR);
    url.search = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: `idecor:${fuente.capa}`, outputFormat: 'application/json', srsName: 'EPSG:4326',
    }).toString();
    const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Mapas Córdoba respondió ${res.status} para ${fuente.capa}`);
    datos = await res.json();
    await writeFile(archivo, JSON.stringify(datos));
  }
  const vistos = new Map<string, { base: string; area: Area }>();
  for (const f of datos!.features) {
    const base = enTitulo(String(f.properties[fuente.campo] ?? ''));
    // "SB", "S/N": sin nombre.
    if (base.length < 3 || /^(s\/?[bn]|sin nombre)$/i.test(base) || !f.geometry) continue;
    const clave = claveDeBarrio(base);
    const anterior = vistos.get(clave);
    const area = { type: 'Feature', properties: {}, geometry: f.geometry } as Area;
    // Un barrio partido en dos pedazos con el mismo nombre se une.
    vistos.set(clave, { base, area: anterior ? (unir([anterior.area, area]) ?? area) : area });
  }
  return [...vistos.values()];
}

let radios: Promise<Map<string, Area[]>> | null = null;
/** Los radios urbanos oficiales de la Provincia (Mapas Córdoba), por nombre de localidad. Se bajan una vez. */
export function radiosUrbanos(): Promise<Map<string, Area[]>> {
  return radios ??= (async () => {
    const archivo = `${CACHE}/idecor-radios_urbanos.json`;
    let datos = JSON.parse(await readFile(archivo, 'utf8').catch(() => 'null')) as { features: Feature<Polygon | MultiPolygon, { nombre?: string }>[] } | null;
    if (!datos) {
      const url = new URL(IDECOR);
      url.search = new URLSearchParams({
        service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'idecor:radios_urbanos', outputFormat: 'application/json', srsName: 'EPSG:4326',
      }).toString();
      const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`Mapas Córdoba respondió ${res.status} para radios_urbanos`);
      datos = await res.json();
      await writeFile(archivo, JSON.stringify(datos));
    }
    const porNombre = new Map<string, Area[]>();
    for (const f of datos!.features) {
      if (!f.geometry || !f.properties.nombre) continue;
      const clave = normalizar(f.properties.nombre);
      (porNombre.get(clave) ?? porNombre.set(clave, []).get(clave)!).push({ type: 'Feature', properties: {}, geometry: f.geometry });
    }
    return porNombre;
  })();
}

let parajes: Promise<{ clave: string; punto: Position }[]> | null = null;
/** Los parajes, comunas y localidades que la Provincia tiene como punto (Mapas Córdoba). Se bajan una vez. */
function parajesDeLaProvincia(): Promise<{ clave: string; punto: Position }[]> {
  return parajes ??= (async () => {
    const archivo = `${CACHE}/idecor-localidad_punto.json`;
    let datos = JSON.parse(await readFile(archivo, 'utf8').catch(() => 'null')) as { features: Feature<Point | MultiPoint, { localidad?: string }>[] } | null;
    if (!datos) {
      const url = new URL(IDECOR);
      url.search = new URLSearchParams({
        service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'idecor:localidad_punto', outputFormat: 'application/json', srsName: 'EPSG:4326',
      }).toString();
      const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (!res?.ok) return []; // sin estos puntos se sigue buscando en Nominatim
      datos = await res.json();
      await writeFile(archivo, JSON.stringify(datos));
    }
    return datos!.features.filter((f) => f.geometry && f.properties.localidad)
      .map((f) => ({ clave: claveDeBarrio(f.properties.localidad!), punto: turf.centroid(f).geometry.coordinates }));
  })();
}

/**
 * El casco recortado al radio urbano oficial de su localidad: las calles y casas sueltas de las sierras no lo
 * estiran hasta el pueblo de al lado. Si no hay radio (parajes, comunas sin plano) o no se tocan, queda como estaba.
 */
export function alRadio(casco: Area | null, radiosDeLaLocalidad: Area[]): Area | null {
  if (!casco || radiosDeLaLocalidad.length === 0) return casco;
  const partes = radiosDeLaLocalidad.map((r) => interseccion(casco, r)).filter((a): a is Area => Boolean(a));
  return unir(partes) ?? casco;
}

// ---------------------------------------------------------------------------------------------
// Casco urbano
// ---------------------------------------------------------------------------------------------

/**
 * La parte urbana de la localidad: la unión de las zonas residenciales, comerciales e industriales de OSM, de los
 * barrios con contorno y de una franja de 45 m alrededor de cada calle residencial (en muchos pueblos OSM tiene las
 * calles pero no las zonas residenciales), cerrando huecos chicos (40 m). Se quedan los pedazos grandes o cercanos
 * al centro del pueblo, y se recorta al ejido. Si OSM no tiene nada, devuelve null (queda el contorno que ya había).
 */
export function cascoUrbano(elementos: ElementoOsm[], localidad: Localidad, barrios: Area[]): Area | null {
  const usos = elementos
    .filter((e) => /^(residential|commercial|retail|industrial)$/.test(e.tags?.landuse ?? ''))
    .map(areaDe)
    .filter((a): a is Area => a !== null);
  const calles = elementos
    .filter((e) => e.type === 'way' && /^(residential|living_street)$/.test(e.tags?.highway ?? '') && (e.geometry?.length ?? 0) >= 2)
    .map((e) => e.geometry!.map(punto));
  const alrededorDeCalles = calles.length > 0 ? (turf.buffer(turf.multiLineString(calles), 45, { units: 'meters' }) as Area | undefined) : undefined;
  const todo = unir([...usos, ...barrios, ...(alrededorDeCalles ? [alrededorDeCalles] : [])]);
  if (!todo) return null;
  const ampliado = turf.buffer(todo, 40, { units: 'meters' }) as Area | undefined;
  if (!ampliado) return null;
  const centro = turf.centroid(comoArea(localidad));
  const partes = turf.flatten(ampliado).features.filter((p) =>
    km2(p) > 0.05 || turf.distance(turf.centroid(p), centro, { units: 'kilometers' }) < 2);
  const casco = unir(partes);
  if (!casco) return null;
  const esEjido = (localidad.properties.osm ?? '').startsWith('R');
  const recortado = esEjido ? interseccion(casco, comoArea(localidad)) : casco;
  return recortado ? (turf.simplify(recortado, { tolerance: 0.0001 }) as Area) : null;
}

// ---------------------------------------------------------------------------------------------
// Barrios
// ---------------------------------------------------------------------------------------------

export type Semilla = { base: string; punto: Position; fuente: 'osm' | 'nominatim' };

/** Barrios de OSM con contorno (el más grande por nombre) y los que son solo un punto. */
export function barriosDeOsm(elementos: ElementoOsm[], localidad: Localidad): { areas: Map<string, { base: string; area: Area }>; puntos: Semilla[] } {
  const areas = new Map<string, { base: string; area: Area }>();
  const puntos: Semilla[] = [];
  const nombreLocalidad = claveDeBarrio(localidad.properties.nombre);
  const ejido = km2(comoArea(localidad));
  // Lo que se baja es un rectángulo: los barrios de pueblos vecinos quedan afuera (se acepta hasta 300 m del borde).
  const adentro = turf.buffer(comoArea(localidad), 0.3, { units: 'kilometers' })!;
  const esDeAca = (p: Position) => turf.booleanPointInPolygon(p, adentro);
  for (const e of elementos) {
    const nombre = e.tags?.name?.trim();
    if (!nombre) continue;
    const esBarrio = /^(suburb|neighbourhood|quarter|hamlet|isolated_dwelling|locality)$/.test(e.tags?.place ?? '')
      || e.tags?.landuse === 'residential' || /^(9|10)$/.test(e.tags?.admin_level ?? '');
    const clave = claveDeBarrio(nombre);
    if (!esBarrio || clave === nombreLocalidad || clave.length < 3 || /^(equip|area \d|manzana|lote)\b/.test(clave)) continue;
    if (e.type === 'node') {
      if (esDeAca([e.lon!, e.lat!])) puntos.push({ base: nombre, punto: [e.lon!, e.lat!], fuente: 'osm' });
      continue;
    }
    const area = areaDe(e);
    // Un "barrio" casi tan grande como el pueblo es en realidad el pueblo (o un error de OSM).
    if (!area || km2(area) > Math.max(0.6 * ejido, 0.01) && km2(area) > 3) continue;
    if (!esDeAca(turf.centroid(area).geometry.coordinates)) continue;
    const anterior = areas.get(clave);
    if (!anterior || km2(area) > km2(anterior.area)) areas.set(clave, { base: nombre, area });
  }
  // Los puntos que ya tienen contorno no hacen falta.
  return { areas, puntos: puntos.filter((p) => !areas.has(claveDeBarrio(p.base))) };
}

// Una cola para Nominatim compartida por todos los que trabajan en paralelo: un pedido cada 1,1 segundos en total.
let proximoTurno = 0;
async function turnoNominatim() {
  const espera = Math.max(0, proximoTurno - Date.now());
  proximoTurno = Date.now() + espera + 1100;
  await pausa(espera);
}

/** Busca un barrio por nombre dentro de la caja de la localidad (Nominatim, con caché). */
async function buscarEnNominatim(nombre: string, localidad: Localidad, cache: Record<string, Position | null>): Promise<Position | null> {
  const clave = `${localidad.properties.nombre}|${claveDeBarrio(nombre)}`;
  if (clave in cache) return cache[clave] ?? buscarParaje(nombre, localidad, cache);
  const [oeste, sur, este, norte] = turf.bbox(turf.buffer(comoArea(localidad), 2, { units: 'kilometers' })!);
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    q: `${nombre}, ${localidad.properties.nombre}`, format: 'jsonv2', limit: '5', countrycodes: 'ar',
    viewbox: `${oeste},${norte},${este},${sur}`, bounded: '1',
  }).toString();
  await turnoNominatim(); // Nominatim pide como mucho un pedido por segundo
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return null; // sin guardar: se reintenta la próxima vez
  type Resultado = { lat: string; lon: string; category: string; type: string; name: string };
  const resultados = (await res.json()) as Resultado[];
  // Un lugar o un barrio, no una calle con el mismo nombre (que es lo más común: "San Martín", "Mitre"…).
  const elegido = resultados.find((r) => ['place', 'landuse', 'boundary', 'leisure'].includes(r.category)
    && claveDeBarrio(r.name) === claveDeBarrio(nombre));
  cache[clave] = elegido ? [Number(elegido.lon), Number(elegido.lat)] : null;
  return cache[clave] ?? buscarParaje(nombre, localidad, cache);
}

/**
 * Los cortes rurales nombran parajes que quedan lejos del pueblo (San Pedro Viejo, Inchilín, Campo Tagle…): se
 * buscan solos, como lugar poblado, hasta 25 km alrededor de la localidad.
 */
async function buscarParaje(nombre: string, localidad: Localidad, cache: Record<string, Position | null>): Promise<Position | null> {
  // Primero los parajes y comunas que la Provincia tiene ubicados (Potrero de Garay, San Clemente, Los Pozos…).
  const centro = turf.centroid(comoArea(localidad)).geometry.coordinates;
  const buscado = claveDeBarrio(nombre.replace(/^(comuna|paraje)\s+(de\s+)?/i, ''));
  const oficial = (await parajesDeLaProvincia()).find((p) => p.clave === buscado && turf.distance(centro, p.punto) < 30);
  if (oficial) return oficial.punto;
  const clave = `paraje|${localidad.properties.nombre}|${claveDeBarrio(nombre)}`;
  if (clave in cache) return cache[clave];
  const [oeste, sur, este, norte] = turf.bbox(turf.buffer(comoArea(localidad), 25, { units: 'kilometers' })!);
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    q: nombre, format: 'jsonv2', limit: '5', countrycodes: 'ar', viewbox: `${oeste},${norte},${este},${sur}`, bounded: '1',
  }).toString();
  await turnoNominatim();
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return null;
  type Resultado = { lat: string; lon: string; category: string; type: string; name: string };
  const resultados = (await res.json()) as Resultado[];
  const elegido = resultados.find((r) => r.category === 'place'
    && ['hamlet', 'village', 'locality', 'isolated_dwelling', 'neighbourhood', 'suburb', 'farm'].includes(r.type)
    && claveDeBarrio(r.name) === claveDeBarrio(nombre));
  cache[clave] = elegido ? [Number(elegido.lon), Number(elegido.lat)] : null;
  return cache[clave];
}

/**
 * Contornos aproximados para los barrios que son solo un punto: la celda de Voronoi de cada punto (el área más
 * cercana a él que a cualquier otro barrio), recortada a un círculo (como mucho 600 m de radio, menos si hay
 * barrios cerca), al casco urbano si el punto está adentro, y sin pisar los barrios con contorno.
 */
export function aproximar(semillas: Semilla[], conContorno: Area[], casco: Area | null, radioMaximo = 600): { base: string; area: Area; fuente: Semilla['fuente'] }[] {
  if (semillas.length === 0) return [];
  const centros = [...semillas.map((s) => s.punto), ...conContorno.map((a) => turf.centroid(a).geometry.coordinates)];
  const caja = turf.bbox(turf.buffer(turf.points(centros), 2, { units: 'kilometers' })!);
  const celdas = turf.voronoi(turf.points(centros), { bbox: caja });
  const ocupado = unir(conContorno);
  const resultado: { base: string; area: Area; fuente: Semilla['fuente'] }[] = [];
  semillas.forEach((s, i) => {
    const otros = centros.filter((_, j) => j !== i);
    const masCerca = otros.length ? Math.min(...otros.map((o) => turf.distance(s.punto, o, { units: 'meters' }))) : 1200;
    const radio = Math.max(Math.min(150, radioMaximo), Math.min(radioMaximo, masCerca * 0.6));
    let area: Area | null = turf.circle(s.punto, radio, { units: 'meters', steps: 32 });
    const celda = celdas.features[i];
    if (celda) area = interseccion(area, celda as Area) ?? area;
    if (casco && turf.booleanPointInPolygon(s.punto, casco)) area = interseccion(area, casco) ?? area;
    if (ocupado && area) area = diferencia(area, ocupado);
    if (!area || km2(area) < 0.005) area = turf.circle(s.punto, 120, { units: 'meters', steps: 24 });
    resultado.push({ base: s.base, area, fuente: s.fuente });
  });
  return resultado;
}

/** Coordenadas con 5 decimales (~1 m) y contorno simplificado (~5 m): el archivo queda liviano. */
export const aliviar = (a: Area): Area => {
  const simple = turf.simplify(a, { tolerance: 0.00005, highQuality: false }) as Area;
  return { ...simple, geometry: { ...simple.geometry, coordinates: redondear(simple.geometry.coordinates) as never } };
};

// ---------------------------------------------------------------------------------------------
// Programa
// ---------------------------------------------------------------------------------------------

if (import.meta.main) {
  await mkdir(CACHE, { recursive: true });
  const zonas = JSON.parse(await readFile('data/zonas.geojson', 'utf8')) as { type: 'FeatureCollection'; features: Localidad[] };
  const cortes = JSON.parse(await readFile('data/mantenimientos.json', 'utf8')) as { localidad: string; zona: string }[];
  const buscadas = JSON.parse(await readFile('data/localidades-buscadas.json', 'utf8')) as Record<string, Candidato[]>;
  const cacheNominatim = JSON.parse(await readFile(`${CACHE}/nominatim.json`, 'utf8').catch(() => '{}')) as Record<string, Position | null>;
  const soloEsta = process.argv[2]; // para probar con una sola localidad: npm run barrios-interior -- "La Calera"

  // Los barrios que nombra EPEC en cada localidad, tramo por tramo (sin buscar nada en internet).
  const sinRed = { buscar: async () => [] as Candidato[], geometria: async () => ({ type: 'Polygon', coordinates: [] }) };
  const ubicarLocalidades = crearUbicadorDeLocalidades(zonas.features, { ...buscadas }, sinRed);
  const nombresEpec = new Map<string, Set<string>>();
  for (const c of cortes.filter((c) => c.localidad && c.localidad !== 'Córdoba')) {
    for (const tramo of tramosDelCorte(c.localidad, c.zona)) {
      const { localidades } = await ubicarLocalidades(tramo.nombres);
      const nombres = nombresDelTramo(tramo.texto);
      for (const l of localidades) nombres.forEach((n) => (nombresEpec.get(l) ?? nombresEpec.set(l, new Set()).get(l)!).add(n));
    }
  }

  const barrios: BarrioInterior[] = [];
  const localidades = zonas.features.filter((z) => z.properties.tipo === 'localidad' && (!soloEsta || z.properties.nombre === soloEsta));
  const clavesDeLocalidades = zonas.features.filter((z) => z.properties.tipo === 'localidad').map((z) => claveDeBarrio(z.properties.nombre));
  /** Arma los barrios y el casco urbano de una localidad. */
  const procesar = async (localidad: Localidad, n: number, servidor: string) => {
    const nombre = localidad.properties.nombre;
    try {
      const elementos = await bajarOsm(localidad, servidor);
      const osm = barriosDeOsm(elementos, localidad);
      // Los barrios oficiales del municipio mandan; de OSM quedan los que no caen adentro de uno oficial.
      const oficiales = await bajarBarriosOficiales(localidad);
      const areas = new Map<string, { base: string; area: Area; fuente: BarrioInterior['properties']['fuente'] }>();
      const enOficial = (a: Area) => oficiales.some((o) => turf.booleanPointInPolygon(turf.pointOnFeature(a), o.area));
      for (const [clave, a] of osm.areas) if (!enOficial(a.area)) areas.set(clave, { ...a, fuente: 'osm' });
      for (const o of oficiales) areas.set(claveDeBarrio(o.base), { ...o, fuente: 'municipio' });
      /**
       * Un lugar que es solo un punto pero cae en un barrio oficial ("Rivadavia" adentro de "Bernardino Rivadavia")
       * toma el contorno oficial, en vez de un círculo encimado. "Centro" con "Centro Norte", "Centro Sur"… toma la
       * unión de todos. Devuelve false si no hay barrio oficial que lo cubra.
       */
      const tomarOficial = (base: string, punto: Position) => {
        const clave = claveDeBarrio(base);
        const partes = oficiales.filter((o) => claveDeBarrio(o.base).startsWith(`${clave} `));
        const contiene = oficiales.find((o) => turf.booleanPointInPolygon(punto, o.area));
        const area = partes.length > 0 ? unir(partes.map((o) => o.area)) : contiene?.area;
        if (!area) return false;
        areas.set(clave, { base, area, fuente: 'municipio' });
        return true;
      };
      const puntos = osm.puntos.filter((p) => !areas.has(claveDeBarrio(p.base)) && !tomarOficial(p.base, p.punto));
      const radio = (await radiosUrbanos()).get(normalizar(nombre)) ?? [];
      const casco = alRadio(cascoUrbano(elementos, localidad, [...areas.values()].map((a) => a.area)), radio);

      // Lo que nombra EPEC y OSM no tiene: se busca en Nominatim dentro de la localidad.
      // Los nombres que son localidades no se buscan: ya tienen su casco.
      const conocidos = new Set([...areas.keys(), ...puntos.map((p) => claveDeBarrio(p.base)), ...clavesDeLocalidades]);
      const semillas = [...puntos];
      let encontrados = 0;
      for (const pedido of nombresEpec.get(nombre) ?? []) {
        if (conocidos.has(claveDeBarrio(pedido))) continue;
        const lugar = await buscarEnNominatim(pedido, localidad, cacheNominatim);
        if (lugar) {
          const base = pedido.replace(/(^|\s)\p{L}/gu, (l) => l.toUpperCase()); // con \b\w, "Cóndor" quedaba "CóNdor"
          if (!tomarOficial(base, lugar)) semillas.push({ base, punto: lugar, fuente: 'nominatim' });
          conocidos.add(claveDeBarrio(pedido));
          encontrados++;
        }
      }
      await writeFile(`${CACHE}/nominatim.json`, JSON.stringify(cacheNominatim));

      const conContorno = [...areas.values()];
      const aproximados = aproximar(semillas, conContorno.map((a) => a.area), casco);
      for (const { base, area, fuente } of conContorno) {
        barrios.push({ ...aliviar(area), properties: { nombre: `${base} (${nombre})`, base, localidad: nombre, tipo: 'poligono', fuente } } as BarrioInterior);
      }
      for (const { base, area, fuente } of aproximados) {
        barrios.push({ ...aliviar(area), properties: { nombre: `${base} (${nombre})`, base, localidad: nombre, tipo: 'aproximado', fuente } } as BarrioInterior);
      }
      if (casco) {
        localidad.geometry = aliviar(casco).geometry as never;
        localidad.properties.contorno = true; // ya no es un círculo: la página lo dibuja como área
        localidad.properties.descripcion = `El área marcada corresponde a la zona urbana de ${nombre}. Es una referencia aproximada.`;
      }
      const pedidos = nombresEpec.get(nombre)?.size ?? 0;
      console.log(`[${n + 1}/${localidades.length}] ${nombre}: ${conContorno.length} con contorno, ${aproximados.length} aproximados`
        + ` (${encontrados} de Nominatim), EPEC nombra ${pedidos}, casco ${casco ? `${km2(casco).toFixed(1)} km²` : 'sin datos'}`);
    } catch (error) {
      console.warn(`[${n + 1}/${localidades.length}] ${nombre}: ${(error as Error).message}`);
    }
    await pausa(3000); // sin apurar a Overpass, que es gratuito y compartido
  };
  // Una tanda por servidor, cada una tomando la próxima localidad que falta.
  let siguiente = 0;
  await Promise.all(SERVIDORES.map(async (servidor) => {
    while (siguiente < localidades.length) {
      const n = siguiente++;
      await procesar(localidades[n], n, servidor);
    }
  }));

  // Nombres únicos en todo el mapa (dos barrios de la misma localidad con el mismo nombre: queda el primero).
  const vistos = new Set<string>();
  const unicos = barrios.filter((b) => !vistos.has(b.properties.nombre) && vistos.add(b.properties.nombre));
  if (!soloEsta) {
    // Los contornos corregidos a mano con el editor (src/contornos.ts) mandan.
    await writeFile('data/barrios-interior.geojson', JSON.stringify(aplicarContornos({ type: 'FeatureCollection', features: unicos }, 'interior')) + '\n');
    await writeFile('data/zonas.geojson', JSON.stringify(aplicarContornos(zonas, 'zonas'), null, 1) + '\n');
  } else {
    await writeFile(`${CACHE}/prueba-${normalizar(soloEsta).replace(/\s+/g, '-')}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: [...unicos, ...localidades] }));
  }
  console.log(`Listo: ${unicos.length} barrios del interior.`);
}

