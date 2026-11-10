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
import { crearUbicadorDeLocalidades, escapar, tramosDelCorte, type Candidato, type Localidad } from './localidades.ts';
import { claveDeBarrio, distancia, nombresDelTramo } from './nombres.ts';
import { aplicarContornos, ARCHIVO_REVISADOS, leerManuales } from './contornos.ts';

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

let parajes: Promise<{ clave: string; nombre: string; punto: Position }[]> | null = null;
/** Los parajes, comunas y localidades que la Provincia tiene como punto (Mapas Córdoba). Se bajan una vez. */
function parajesDeLaProvincia(): Promise<{ clave: string; nombre: string; punto: Position }[]> {
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
      .map((f) => ({ clave: claveDeBarrio(f.properties.localidad!), nombre: enTitulo(f.properties.localidad!), punto: turf.centroid(f).geometry.coordinates }));
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
export function cascoUrbano(elementos: ElementoOsm[], centro: Position, alcance: number, barrios: Area[]): Area | null {
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
  // Los pedazos cerca del centro del pueblo, o que tocan uno de sus barrios. Antes entraba cualquier pedazo grande
  // y el casco se comía los pueblos de al lado (Tanti, Icho Cruz).
  const cerca = (p: Area) => turf.distance(turf.pointOnFeature(p), centro, { units: 'kilometers' }) < alcance
    || turf.booleanPointInPolygon(centro, p);
  const partes = turf.flatten(ampliado).features.filter((p) => cerca(p) || barrios.some((b) => interseccion(p, b)));
  const casco = unir(partes);
  // No se recorta al contorno guardado: ese es el casco de la corrida anterior, y recortarlo lo iba achicando
  // hasta dejar barrios afuera (La Calera, Saldán). El límite lo pone el radio urbano oficial (alRadio).
  return casco ? simplificar(casco, 0.0001) : null;
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

const ROMANOS: Record<string, string> = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8' };
const NUMEROS: Record<string, string> = { uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9', diez: '10' };
/** "Country Tejas Cuatro", "Tejas 4" y "TEJAS 4 (Malagueño)" son el mismo lugar. Exportado para los tests. */
export function claveDeLugar(base: string): string {
  // "Coop. La Unidad" y "Cooperativa La Unidad", "Ex Batallón 141" y "Batallon 141", "Greenville II" y "GreenVille 2",
  // "Villa de Emergencia El Chaparral" y "Villa El Chaparral".
  const limpio = base.replace(/\s*\([^)]*\)/g, '').replace(/^villa de emergencia\s+/i, 'villa ')
    .replace(/^((country|barrio privado|barrio cerrado|barrio|b°|bº|complejo|urbanizaci[oó]n|loteo|privado|ex|coop\.?|cooperativa|vecinal)\s+)+/i, '')
    .replace(/\s*-?\s*barrio (cerrado|privado)\s*-?\s*$/i, ''); // "Las Cañitas Barrio Privado", "La Serena -Barrio Cerrado-"
  return claveDeBarrio(limpio).split(' ').map((p) => NUMEROS[p] ?? ROMANOS[p] ?? p).join(' ');
}

type BarrioConFuente = { properties: { nombre: string; base?: string; localidad: string; tipo?: string; fuente?: string; alias?: string[] } };
const CONFIANZA: Record<string, number> = { municipio: 0, municipalidad: 0, manual: 1, osm: 2, nominatim: 3 };
/**
 * Un barrio por lugar en cada localidad. Si dos fuentes traen el mismo ("Tejas 4" y "Country Tejas Cuatro"), queda
 * el más confiable (del municipio, dibujado a mano, de OSM, aproximado) y el nombre del otro queda como alias, así
 * se lo sigue reconociendo como lo escriba EPEC. Exportado para los tests.
 */
/** "El Talar de Mendiolaza" y "El Talar", "Villa Allende Centro" y "Centro": el nombre sin la localidad. */
export function claveSinLocalidad(base: string, localidad: string): string {
  const loc = claveDeLugar(localidad);
  const clave = claveDeLugar(base);
  const sin = clave.replace(new RegExp(`( de| del)? ${loc}$`), '').replace(new RegExp(`^${loc} `), '');
  return sin.length >= 3 ? sin : clave;
}

export function sinRepetidos<F extends BarrioConFuente>(barrios: F[], centros?: Map<string, Position>, nombradosEnCapital?: Set<string>): F[] {
  const rango = (b: F) => (b.properties.tipo === 'aproximado' ? 10 : 0) + (CONFIANZA[b.properties.fuente ?? ''] ?? 5);
  const ganador = new Map<string, F>();
  // Un "barrio" que es la localidad entera ("Villa Saldán" en Saldán) se saca: se encima con todos los demás.
  const esLaLocalidad = (b: F) => b.properties.localidad !== 'Córdoba'
    && claveDeLugar(b.properties.base ?? b.properties.nombre).replace(/^villa /, '') === claveDeLugar(b.properties.localidad).replace(/^villa /, '');
  for (const b of [...barrios].filter((x) => !esLaLocalidad(x)).sort((x, y) => rango(x) - rango(y))) {
    const clave = `${b.properties.localidad}|${claveSinLocalidad(b.properties.base ?? b.properties.nombre, b.properties.localidad)}`;
    const ya = ganador.get(clave);
    if (!ya) ganador.set(clave, b);
    else if (ya.properties.base !== b.properties.base) ya.properties.alias = [...new Set([...(ya.properties.alias ?? []), b.properties.base ?? b.properties.nombre])];
  }
  // Los que se escriben casi igual ("Brisas de Manatiales" y "Brisas de Manantiales") y están en el mismo lugar.
  const quedan = new Set(ganador.values());
  // El mismo barrio como división de capital y como barrio de una localidad vecina, en el mismo lugar ("San Remo" de
  // Saldán): se va la copia de capital (salvo que sea oficial). Entre dos localidades del interior quedan los dos: EPEC
  // puede nombrarlo en cualquiera, y sacar uno rompía el reconocimiento ("Centro" de Villa Nueva, "Bella Vista").
  const porClave = new Map<string, F[]>();
  for (const b of quedan) {
    const clave = claveDeLugar(b.properties.base ?? b.properties.nombre);
    porClave.set(clave, [...(porClave.get(clave) ?? []), b]);
  }
  const preferencia = (b: F) => {
    const oficial = ['municipio', 'municipalidad'].includes(b.properties.fuente ?? '') ? 0 : 1;
    const capital = b.properties.localidad === 'Córdoba' ? 1 : 0;
    const centro = centros?.get(b.properties.localidad);
    let distanciaAlCentro = 0;
    try {
      distanciaAlCentro = centro ? turf.distance(turf.pointOnFeature(b as unknown as Area), centro) : 0;
    } catch {
      // sin geometría
    }
    return oficial * 1000 + capital * 100 + distanciaAlCentro;
  };
  for (const grupo of porClave.values()) {
    if (new Set(grupo.map((b) => b.properties.localidad)).size < 2) continue;
    const orden = [...grupo].sort((x, y) => preferencia(x) - preferencia(y));
    for (const [i, a] of orden.entries()) {
      if (!quedan.has(a)) continue;
      for (const b of orden.slice(i + 1)) {
        if (!quedan.has(b) || b.properties.localidad === a.properties.localidad) continue;
        if (b.properties.localidad !== 'Córdoba' || a.properties.localidad === 'Córdoba') continue;
        // EPEC la nombra en sus cortes de capital ("Ciudad de los Niños"): sin esta copia, el corte no se pinta.
        if (nombradosEnCapital?.has(claveDeLugar(b.properties.base ?? b.properties.nombre))) continue;
        try {
          const comun = turf.intersect(turf.featureCollection([a as unknown as Area, b as unknown as Area]));
          const menor = Math.min(turf.area(a as unknown as Area), turf.area(b as unknown as Area));
          if (comun && turf.area(comun) >= 0.3 * menor) quedan.delete(b);
        } catch {
          // sin geometría: no se puede saber si es el mismo lugar
        }
      }
    }
  }
  const lista = [...quedan].sort((x, y) => rango(x) - rango(y));
  const caja = (b: F) => turf.bbox(b as unknown as Area);
  for (const [i, a] of lista.entries()) {
    if (!quedan.has(a)) continue;
    const ka = claveDeLugar(a.properties.base ?? a.properties.nombre);
    for (const b of lista.slice(i + 1)) {
      if (!quedan.has(b) || b.properties.localidad !== a.properties.localidad) continue;
      const kb = claveDeLugar(b.properties.base ?? b.properties.nombre);
      const largo = Math.min(ka.length, kb.length);
      const tolerancia = largo >= 14 ? 2 : largo >= 8 ? 1 : 0;
      const casiIgual = tolerancia > 0 && Math.abs(ka.length - kb.length) <= tolerancia && distancia(ka, kb) <= tolerancia;
      // "Manuel Belgrano" y "Belgrano" en Carlos Paz: variantes que además se pisan en más del 60 %.
      const variante = !casiIgual && esVariante(a.properties.base ?? a.properties.nombre, b.properties.base ?? b.properties.nombre) && (() => {
        try {
          const comun = turf.intersect(turf.featureCollection([a as unknown as Area, b as unknown as Area]));
          return Boolean(comun) && turf.area(comun!) > 0.6 * Math.min(turf.area(a as unknown as Area), turf.area(b as unknown as Area));
        } catch {
          return false;
        }
      })();
      if (!casiIgual && !variante) continue;
      let cerca = false;
      try {
        const [ao, as, ae, an] = caja(a), [bo, bs, be, bn] = caja(b);
        cerca = !(ao > be || bo > ae || as > bn || bs > an);
      } catch {
        // sin geometría: no se puede saber si es el mismo lugar
      }
      if (!cerca) continue; // lejos: son dos lugares distintos
      quedan.delete(b);
      a.properties.alias = [...new Set([...(a.properties.alias ?? []), b.properties.base ?? b.properties.nombre])];
    }
  }
  return barrios.filter((b) => quedan.has(b));
}

// Variantes del mismo nombre ("Alejandro Carbó" y "Carbo", "Manuel Belgrano" y "Belgrano"): solo si lo que sobra son
// palabras genéricas, títulos o nombres de pila, y los números coinciden. Nunca si sobra algo que describe una parte.
const ORDINALES: Record<string, string> = { primera: '1', primero: '1', segunda: '2', segundo: '2', tercera: '3', tercero: '3', cuarta: '4', cuarto: '4', quinta: '5', quinto: '5' };
const GENERICAS = new Set(['barrio', 'residencial', 'ciudad', 'parque', 'estancia', 'villa', 'finca', 'tte', 'teniente', 'doctor', 'dr', 'general', 'domingo', 'faustino', 'maria', 'roque',
  'presidente', 'ingeniero', 'alejandro', 'mariano', 'nicolas', 'benjamin', 'policarpio', 'rene', 'jose', 'juan', 'manuel', 'militar', 'seccion']);
const palabras = (t: string) => claveDeLugar(t).split(' ').map((p) => ORDINALES[p] ?? p.replace(/^(\d+)[aoº°]?$/, '$1')).filter((p) => p.length > 0);
export const esVariante = (a: string, b: string) => {
  const x = new Set(palabras(a)), y = new Set(palabras(b));
  const comunes = [...x].filter((p) => y.has(p));
  if (comunes.filter((p) => !GENERICAS.has(p) && !/^\d+$/.test(p)).length === 0) return false;
  const sobran = [...x, ...y].filter((p) => !(x.has(p) && y.has(p)));
  return sobran.every((p) => GENERICAS.has(p) || (p.length <= 2 && !/^\d+$/.test(p)));
};

/** Si dos nombres son la misma localidad: iguales, o uno es el comienzo del otro ("Villa Yacanto de Calamuchita"). */
export function mismaLocalidad(a: string, b: string): boolean {
  // Sin claveDeLugar: esa borra el "Villa" del principio, y "Villa Quilino" no es Quilino (están a 2,6 km).
  const x = normalizar(a);
  const y = normalizar(b);
  if (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)) return true;
  // "Icho Cruz" y "Villa Río Icho Cruz" (el radio oficial): uno termina con el otro, si el corto no es una sola palabra.
  const corto = x.length < y.length ? x : y;
  const largo = corto === x ? y : x;
  if (corto.includes(' ') && largo.endsWith(` ${corto}`)) return true;
  // Una letra de diferencia en nombres largos: "James Craik" y "James Craick".
  return Math.min(x.length, y.length) >= 8 && Math.abs(x.length - y.length) <= 1 && distancia(x, y) <= 1;
}

/**
 * Simplifica el contorno. Si queda algún pedacito de menos de 4 puntos (pasa al restar una localidad de otra), se
 * descartan los pedacitos de menos de 1000 m² y se vuelve a probar; si igual no se puede, queda como estaba.
 */
export function simplificar(a: Area, tolerancia: number): Area {
  try {
    return turf.simplify(a, { tolerance: tolerancia, highQuality: false }) as Area;
  } catch {
    const grandes = turf.flatten(a).features.filter((p) => turf.area(p) >= 1000);
    if (grandes.length === 0) return a;
    const sinPedacitos = { ...a, geometry: { type: 'MultiPolygon', coordinates: grandes.map((p) => p.geometry.coordinates) } } as Area;
    try {
      return turf.simplify(sinPedacitos, { tolerance: tolerancia, highQuality: false }) as Area;
    } catch {
      return sinPedacitos;
    }
  }
}

/** Coordenadas con 5 decimales (~1 m) y contorno simplificado (~5 m): el archivo queda liviano. */
export const aliviar = (a: Area): Area => {
  const simple = simplificar(a, 0.00005);
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

  // Localidades oficiales que quedaron adentro de otra (Villa San Nicolás y Yocsina en Malagueño, Tala Huasi junto a
  // Icho Cruz): van con su propio contorno. "dentroDe" sirve para reconocerlas si EPEC las nombra como barrio de la
  // grande. No se agregan las que se llaman como un barrio de capital (Guiñazú): ahí manda capital.
  const radiosOficiales = await radiosUrbanos();
  const capitalJson = JSON.parse(await readFile('data/barrios.geojson', 'utf8')) as { features: { properties: { nombre: string | null } }[] };
  const barriosDeCapital = new Set(capitalJson.features.flatMap((f) => (f.properties.nombre ? [claveDeLugar(f.properties.nombre)] : [])));
  // Las que se crearon de más en corridas anteriores (el mismo pueblo escrito distinto: "James Craick") se borran.
  // A menos de 1,5 km del centro de otra localidad (u 800 m de la que la contiene) es esa misma.
  const cercaDeOtra = (punto: Position, madre?: string) => zonas.features.some((o) => o.properties.tipo === 'localidad' && !o.properties.dentroDe
    && turf.distance(turf.centroid(comoArea(o)), punto) < (o.properties.nombre === madre ? 0.8 : 1.5));
  zonas.features = zonas.features.filter((z) => !z.properties.dentroDe || (!zonas.features.some((o) => o !== z
    && !o.properties.dentroDe && o.properties.tipo === 'localidad' && mismaLocalidad(o.properties.nombre, z.properties.nombre))
    && !cercaDeOtra(turf.centroid(comoArea(z)).geometry.coordinates, z.properties.dentroDe)));
  const nuestras = zonas.features.filter((z) => z.properties.tipo === 'localidad');
  const barriosAnteriores = (JSON.parse(await readFile('data/barrios-interior.geojson', 'utf8').catch(() => '{"features":[]}')) as { features: BarrioInterior[] }).features;
  for (const p of await parajesDeLaProvincia()) {
    if (nuestras.some((z) => mismaLocalidad(z.properties.nombre, p.nombre) && turf.distance(turf.centroid(comoArea(z)), p.punto) < 15)) continue;
    const madre = nuestras.find((z) => z.properties.contorno && turf.booleanPointInPolygon(p.punto, comoArea(z)));
    if (!madre || barriosDeCapital.has(claveDeLugar(p.nombre)) || cercaDeOtra(p.punto, madre.properties.nombre)) continue;
    // Si la grande ya tiene un barrio que se llama así ("Country Cuatro Hojas" en Mendiolaza, "Colanchanga" en Río
    // Ceballos), es ese barrio: no se crea otra localidad encima.
    const clave = claveDeLugar(p.nombre);
    const contiene = (a: string, b: string) => ` ${a} `.includes(` ${b} `);
    if (barriosAnteriores.some((b) => b.properties.localidad === madre.properties.nombre
      && (contiene(claveDeLugar(b.properties.base), clave) || contiene(clave, claveDeLugar(b.properties.base))))) continue;
    const radio = radiosOficiales.get(normalizar(p.nombre));
    const area = (radio?.length ? unir(radio) : null) ?? turf.circle(p.punto, 1.5, { units: 'kilometers', steps: 32 });
    zonas.features.push({
      type: 'Feature',
      properties: {
        nombre: p.nombre, tipo: 'localidad', patron: `^${escapar(normalizar(p.nombre))}$`,
        descripcion: `La ubicación de ${p.nombre} es una referencia aproximada.`, dentroDe: madre.properties.nombre,
      },
      geometry: area.geometry,
    } as Localidad);
    console.log(`+ ${p.nombre}: localidad propia (estaba dentro de ${madre.properties.nombre})`);
  }
  // Los barrios rearmados con manzanas oficiales o dibujados a mano también son de la localidad (La Calera).
  const dibujados = new Map<string, Area[]>();
  for (const m of [...leerManuales(ARCHIVO_REVISADOS), ...leerManuales()].filter((m) => m.properties.destino === 'interior' && m.properties.localidad)) {
    dibujados.set(m.properties.localidad!, [...(dibujados.get(m.properties.localidad!) ?? []), { type: 'Feature', properties: {}, geometry: m.geometry } as Area]);
  }
  /** El punto oficial de la localidad (no se corre de una corrida a otra, como el centro del contorno). */
  const puntosOficiales = await parajesDeLaProvincia();
  const centroDe = (localidad: Localidad): Position => {
    const propio = turf.centroid(comoArea(localidad)).geometry.coordinates;
    const oficial = puntosOficiales.filter((p) => mismaLocalidad(p.nombre, localidad.properties.nombre))
      .sort((a, b) => turf.distance(a.punto, propio) - turf.distance(b.punto, propio))[0];
    return oficial && turf.distance(oficial.punto, propio) < 15 ? oficial.punto : propio;
  };
  /** El radio oficial de una localidad, aunque la Provincia lo escriba un poco distinto ("Villa Yacanto"). */
  const radioDe = (localidad: Localidad): Area[] => radiosOficiales.get(normalizar(localidad.properties.nombre))
    ?? [...radiosOficiales.entries()].filter(([n, areas]) => mismaLocalidad(n, localidad.properties.nombre)
      && areas.some((a) => turf.booleanPointInPolygon(turf.centroid(comoArea(localidad)), a))).flatMap(([, a]) => a);

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
      // "Todo lo urbano": las calles cerca del centro, recortadas al radio oficial, más todos sus barrios aunque el
      // radio sea viejo y les quede chico (La Calera, Saldán). Una localidad que está adentro de otra, más acotada.
      const radio = radioDe(localidad);
      const centro = centroDe(localidad);
      const masCercana = Math.min(...zonas.features.filter((z) => z !== localidad && z.properties.tipo === 'localidad')
        .map((z) => turf.distance(centro, centroDe(z))));
      const alcance = localidad.properties.dentroDe ? 1.2 : radio.length > 0 ? 8 : Math.max(0.8, Math.min(3, 0.55 * masCercana));
      // Una localidad que está adentro de otra no toma barrios: los de alrededor son de la grande.
      if (localidad.properties.dentroDe) {
        areas.clear();
        puntos.length = 0;
      }
      const propios = [...areas.values()].map((a) => a.area).concat(localidad.properties.dentroDe ? [] : dibujados.get(nombre) ?? [])
        .filter((a) => turf.distance(turf.pointOnFeature(a), centro) < alcance + 3);
      const crudo = alRadio(cascoUrbano(elementos, centro, alcance, propios), radio);
      // Las calles de dos pueblos pegados forman un solo pedazo: a una localidad que está adentro de otra se le corta en
      // un círculo alrededor de su centro (si no, Yocsina se quedaba con el centro de Malagueño).
      // Lo mismo para las que no tienen radio oficial: Villa Quilino se comía Quilino, a 2,6 km.
      const recortar = localidad.properties.dentroDe || radio.length === 0;
      const calles = crudo && recortar ? interseccion(crudo, turf.circle(centro, alcance, { units: 'kilometers', steps: 48 })) : crudo;
      const casco = calles ? unir([calles, ...propios]) : null;

      // Lo que nombra EPEC y OSM no tiene: se busca en Nominatim dentro de la localidad.
      // Los nombres que son localidades no se buscan: ya tienen su casco.
      const conocidos = new Set([...areas.keys(), ...puntos.map((p) => claveDeBarrio(p.base)), ...clavesDeLocalidades]);
      // "Centro": Nominatim a veces encuentra el de otro pueblo (Bialet Massé). Va en el centro oficial de la localidad.
      const semillas = [...puntos].map((p) => (/^centro$/i.test(p.base.trim()) ? { ...p, punto: centro } : p));
      let encontrados = 0;
      for (const pedido of nombresEpec.get(nombre) ?? []) {
        if (conocidos.has(claveDeBarrio(pedido))) continue;
        const lugar = await buscarEnNominatim(pedido, localidad, cacheNominatim);
        if (lugar) {
          const base = pedido.replace(/(^|\s)\p{L}/gu, (l) => l.toUpperCase()); // con \b\w, "Cóndor" quedaba "CóNdor"
          if (!tomarOficial(base, lugar)) semillas.push({ base, punto: /^centro$/i.test(base.trim()) ? centro : lugar, fuente: 'nominatim' });
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

  // Cada localidad termina donde empieza otra: se le restan los radios oficiales de las demás (salvo el que la
  // contiene, si es un enclave) y las localidades que tiene adentro.
  const conCasco = zonas.features.filter((z) => z.properties.tipo === 'localidad' && z.properties.contorno);
  const centros = new Map(conCasco.map((z) => [z, centroDe(z)]));
  // Un barrio de OSM que quedó en la localidad equivocada (el contorno de Villa Allende cubría Saldán cuando se bajó):
  // si está fuera del radio oficial de la suya y más cerca del centro de otra, pasa a esa otra.
  const porNombre = new Map(conCasco.map((z) => [z.properties.nombre, z]));
  for (const b of barrios) {
    // Solo áreas de OSM; y si EPEC lo nombra en su localidad actual, se queda ahí (aunque el punto esté corrido).
    if (b.properties.fuente !== 'osm' || b.properties.tipo !== 'poligono') continue;
    if ([...(nombresEpec.get(b.properties.localidad) ?? [])].some((n) => claveDeBarrio(n) === claveDeBarrio(b.properties.base))) continue;
    const propia = porNombre.get(b.properties.localidad);
    const radioPropio = propia ? radioDe(propia) : [];
    const punto = turf.pointOnFeature(b as Area);
    if (!propia || radioPropio.length === 0 || radioPropio.some((r) => turf.booleanPointInPolygon(punto, r))) continue;
    const distanciaPropia = turf.distance(punto, centros.get(propia)!);
    const otra = conCasco.filter((z) => z !== propia && !z.properties.dentroDe)
      .map((z) => ({ z, d: turf.distance(punto, centros.get(z)!) })).sort((x, y) => x.d - y.d)[0];
    if (!otra || otra.d >= distanciaPropia || otra.d > 3) continue;
    b.properties.localidad = otra.z.properties.nombre;
    b.properties.nombre = `${b.properties.base} (${otra.z.properties.nombre})`;
  }
  const centrosPorNombre = new Map(conCasco.map((z) => [z.properties.nombre, centros.get(z)!]));
  const originales = new Map(conCasco.map((z) => [z, comoArea(z)]));
  for (const z of conCasco) {
    // Sus barrios cercanos (también los aproximados: Dumesnil y Casa Bamba son de La Calera) son parte de lo urbano.
    const centroZ = centros.get(z)!;
    const cercanos = barrios.filter((b) => b.properties.localidad === z.properties.nombre
      && turf.distance(turf.pointOnFeature(b as Area), centroZ) < (radioDe(z).length > 0 ? 11 : 6)) as Area[];
    const area = unir([comoArea(z), ...(z.properties.dentroDe ? [] : cercanos)]) ?? comoArea(z);
    const [o, s, e, n] = turf.bbox(area);
    const toca = (a: Area) => { const [ao, as, ae, an] = turf.bbox(a); return ao <= e && ae >= o && as <= n && an >= s; };
    const centro = turf.pointOnFeature(area);
    const ajenos = [...radiosOficiales.entries()].filter(([nombre]) => !mismaLocalidad(nombre, z.properties.nombre))
      .flatMap(([, areas]) => areas).filter((a) => toca(a) && !turf.booleanPointInPolygon(centro, a));
    const hijas = conCasco.filter((h) => h.properties.dentroDe === z.properties.nombre).map(comoArea);
    // Cada localidad se queda con su centro: si el de otra cae adentro de esta (Saldán dentro de Villa Allende), se resta.
    const vecinas = conCasco.filter((v) => v !== z && v.properties.dentroDe !== z.properties.nombre && z.properties.dentroDe !== v.properties.nombre
      && turf.booleanPointInPolygon(centros.get(v)!, originales.get(z)!)
      // Si las dos se contienen el centro una a la otra, no se restan las dos (Quilino quedaba en 0,1 km²).
      && !turf.booleanPointInPolygon(centroZ, originales.get(v)!)).map((v) => originales.get(v)!);
    // Sus barrios no se tocan; y una localidad que está adentro de otra no se queda con los barrios de la grande.
    const poligonosDe = (localidad: string) => unir(barrios.filter((b) => b.properties.localidad === localidad && b.properties.tipo !== 'aproximado') as Area[]);
    const propios = poligonosDe(z.properties.nombre);
    const deLaMadre = z.properties.dentroDe ? poligonosDe(z.properties.dentroDe) : null;
    const quitar = unir([...ajenos, ...hijas, ...vecinas, ...(deLaMadre ? [deLaMadre] : [])]);
    const resto = quitar && propios ? diferencia(quitar, propios) : quitar;
    const queda = resto ? diferencia(area, resto) : null;
    if (queda && km2(queda) > 0.05) z.geometry = aliviar(queda).geometry as never;
  }
  // Un barrio que ahora es una localidad propia (El Pueblito en Salsipuedes) deja de estar como barrio.
  const reemplazados = new Set(zonas.features.filter((z) => z.properties.dentroDe).map((z) => `${z.properties.dentroDe}|${claveDeLugar(z.properties.nombre)}`));
  const sinReemplazados = barrios.filter((b) => !reemplazados.has(`${b.properties.localidad}|${claveDeLugar(b.properties.base)}`));
  if (!soloEsta) {
    // Los contornos corregidos a mano con el editor (src/contornos.ts) mandan. Después, un barrio por lugar.
    const conManuales = aplicarContornos({ type: 'FeatureCollection', features: sinReemplazados }, 'interior');
    const unicos = sinRepetidos(conManuales.features, centrosPorNombre);
    await writeFile('data/barrios-interior.geojson', JSON.stringify({ type: 'FeatureCollection', features: unicos }) + '\n');
    await writeFile('data/zonas.geojson', JSON.stringify(aplicarContornos(zonas, 'zonas'), null, 1) + '\n');
  } else {
    await writeFile(`${CACHE}/prueba-${normalizar(soloEsta).replace(/\s+/g, '-')}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: [...sinReemplazados, ...localidades] }));
  }
  console.log(`Listo: ${sinReemplazados.length} barrios del interior (antes de sacar repetidos).`);
}

