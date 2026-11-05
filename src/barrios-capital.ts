// Contornos para los lugares de capital que no están en el mapa municipal (npm run barrios-capital).
//
// El mapa de la Municipalidad tiene ~485 barrios, pero adentro de algunos hay countries y loteos que EPEC nombra
// por separado (en Valle Escondido: Los Cielos, Las Terrazas, La Reserva…). Hasta ahora eran solo un punto.
// 1. Baja de OpenStreetMap las zonas residenciales y barrios con nombre de la ciudad: si el lugar tiene contorno
//    ahí, se usa ese (y también se suman los que no tenía el mapa: más divisiones para reconocer).
// 2. Los puntos de OSM sin contorno y los nombres de los cortes que no se encuentran (buscados en Nominatim)
//    reciben un contorno APROXIMADO chico (hasta 300 m, repartido con los vecinos), sin salirse del barrio
//    municipal que los contiene: un country de Valle Escondido no pisa el barrio de al lado.
// Quedan en data/barrios-interior.geojson con localidad "Córdoba" (el lector y la página los tratan igual que al
// resto). Correr después de `npm run barrios-interior`, que reescribe ese archivo.
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

import { readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import type { Position } from 'geojson';
import { crearUbicador, esDescripcion, normalizar } from './barrios.ts';
import {
  aliviar, aproximar, areaDe, consultarOverpass, interseccion, km2, SERVIDORES,
  type Area, type BarrioInterior, type ElementoOsm, type Semilla,
} from './barrios-interior.ts';
import { CAPITAL } from './mantenimiento.ts';
import { claveDeBarrio, crearBuscadorDeBarrios } from './nombres.ts';
import { aplicarContornos } from './contornos.ts';

const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };
// La ciudad de Córdoba entra en este rectángulo (oeste, norte, este, sur para Nominatim; sur, oeste, norte, este para Overpass).
const CIUDAD = '-64.32,-31.30,-64.05,-31.55';
const CAJA = '-31.55,-64.32,-31.30,-64.05';
const CACHE = '.cache/barrios-interior';
const pausa = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

type Barrio = { properties: { nombre: string | null; tipo: string }; geometry: { type: string; coordinates: unknown } };
const mapa = JSON.parse(await readFile('data/barrios.geojson', 'utf8')) as { features: Barrio[] };
const alias = JSON.parse(await readFile('data/alias-barrios.json', 'utf8')) as Record<string, string | null>;
const interior = JSON.parse(await readFile('data/barrios-interior.geojson', 'utf8').catch(() => '{"features":[]}')) as { features: BarrioInterior[] };
const cortes = JSON.parse(await readFile('data/mantenimientos.json', 'utf8')) as { localidad?: string; zona: string }[];
const cache = JSON.parse(await readFile(`${CACHE}/nominatim-capital.json`, 'utf8').catch(() => '{}')) as Record<string, Position | null>;

const municipales = mapa.features.filter((f) => f.properties.tipo === 'poligono' && f.properties.nombre) as unknown as (Area & Barrio)[];
const nombresMunicipales = municipales.map((f) => f.properties.nombre!);
const esMunicipal = crearBuscadorDeBarrios(nombresMunicipales.map((n) => ({ nombre: n, base: n, localidad: CAPITAL })));
const nombresDelMapa = mapa.features.flatMap((f) => f.properties.nombre ?? []);
const ubicar = crearUbicador(nombresDelMapa, alias);
const tolerante = crearBuscadorDeBarrios(nombresDelMapa.map((n) => ({ nombre: n, base: n, localidad: CAPITAL })));
// Los alias en null son nombres que a propósito no se ubican (por ejemplo, un loteo que EPEC lista con capital
// pero está en otro departamento): no se buscan.
const ignorados = new Set(Object.keys(alias).filter((n) => alias[n] === null).map(normalizar));
// "Barrio Cerrado Los Cielos" y "Country La Reserva" son "Los Cielos" y "La Reserva".
const sinPrefijo = (n: string) => n.replace(/^(b[°º]|barrio|barrio cerrado|country|club de campo|complejo|loteo|urbanizaci[oó]n)\s+/i, '').trim();

// 1. Zonas con nombre de OpenStreetMap en la ciudad (con caché en disco).
const archivoOsm = `${CACHE}/osm-capital.json`;
let elementos = JSON.parse(await readFile(archivoOsm, 'utf8').catch(() => 'null')) as ElementoOsm[] | null;
if (!elementos) {
  elementos = await consultarOverpass(`[out:json][timeout:180];(
    way["place"~"^(suburb|neighbourhood|quarter|locality)$"]["name"](${CAJA});
    relation["place"~"^(suburb|neighbourhood|quarter|locality)$"]["name"](${CAJA});
    way["landuse"="residential"]["name"](${CAJA});
    relation["landuse"="residential"]["name"](${CAJA});
  );out geom qt;`, 'Córdoba', SERVIDORES[0]);
  await writeFile(archivoOsm, JSON.stringify(elementos));
}
/** Por nombre, el contorno más grande de OSM (entre 3000 m² y 3 km²: ni una manzana suelta ni media ciudad). */
const areasOsm = new Map<string, { base: string; area: Area }>();
for (const e of elementos) {
  const base = sinPrefijo(e.tags?.name?.trim() ?? '');
  const area = areaDe(e);
  // Sin manzanas sueltas ni lotes numerados ("Manzana 4", "Lote 12"): no son lugares que nombre EPEC.
  if (base.length < 3 || /^(manzana|mza|lote|sector|torre|edificio)/i.test(base) || !area || km2(area) < 0.003 || km2(area) > 3) continue;
  const clave = claveDeBarrio(base);
  const anterior = areasOsm.get(clave);
  if (!anterior || km2(area) > km2(anterior.area)) areasOsm.set(clave, { base, area });
}

// 2. Lo que hay que enmarcar: los puntos del mapa y los nombres de los cortes que no aparecen en ningún lado.
const semillas: Semilla[] = mapa.features
  .filter((f) => f.properties.tipo === 'punto' && f.properties.nombre)
  .map((f) => ({ base: f.properties.nombre!, punto: f.geometry.coordinates as Position, fuente: 'osm' as const }));

const faltan = new Set<string>();
for (const c of cortes.filter((c) => (c.localidad ?? CAPITAL) === CAPITAL)) {
  for (const pedazo of ubicar(c.zona).sinUbicar) {
    if (esDescripcion(pedazo) || ignorados.has(pedazo) || /^\d/.test(pedazo) || pedazo.split(' ').length > 5) continue;
    if (tolerante([CAPITAL], pedazo).barrios.length === 0 && !areasOsm.has(claveDeBarrio(pedazo))) faltan.add(pedazo);
  }
}
console.log(`${faltan.size} lugares de capital sin ubicar: ${[...faltan].join(', ')}`);
for (const nombre of faltan) {
  if (!(nombre in cache)) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q: `${nombre}, Córdoba`, format: 'jsonv2', limit: '5', countrycodes: 'ar', viewbox: CIUDAD, bounded: '1' }).toString();
    await pausa(1100); // Nominatim pide como mucho un pedido por segundo
    const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res?.ok) continue;
    const resultados = (await res.json()) as { lat: string; lon: string; category: string; name: string }[];
    // Un lugar o un barrio con ese nombre, no una calle (que es lo más común).
    const elegido = resultados.find((r) => ['place', 'landuse', 'boundary', 'leisure', 'amenity'].includes(r.category)
      && claveDeBarrio(r.name) === claveDeBarrio(nombre));
    cache[nombre] = elegido ? [Number(elegido.lon), Number(elegido.lat)] : null;
    await writeFile(`${CACHE}/nominatim-capital.json`, JSON.stringify(cache));
  }
  const punto = cache[nombre];
  if (punto) semillas.push({ base: nombre.replace(/\b\p{L}/gu, (l) => l.toUpperCase()), punto, fuente: 'nominatim' });
}

// 3. Cada lugar con su contorno de OSM (si está cerca del punto: los nombres se repiten) o uno aproximado.
const nuevos: BarrioInterior[] = [];
const vistos = new Set<string>();
const agregar = (base: string, area: Area, tipo: 'poligono' | 'aproximado', fuente: 'osm' | 'nominatim') => {
  const clave = claveDeBarrio(base);
  if (vistos.has(clave)) return;
  vistos.add(clave);
  nuevos.push({ ...aliviar(area), properties: { nombre: base, base, localidad: CAPITAL, tipo, fuente } } as BarrioInterior);
};
const sinContorno: Semilla[] = [];
for (const s of semillas) {
  // "Country La Reserva" ya está en el mapa municipal como "La Reserva".
  if (esMunicipal([CAPITAL], sinPrefijo(s.base)).barrios.length > 0) continue;
  const osm = areasOsm.get(claveDeBarrio(sinPrefijo(s.base)));
  const cerca = osm && (turf.booleanPointInPolygon(s.punto, osm.area)
    || turf.distance(s.punto, turf.centroid(osm.area), { units: 'kilometers' }) < 1.5);
  if (cerca) agregar(s.base, osm.area, 'poligono', 'osm');
  else sinContorno.push(s);
}
// Las zonas de OSM que el mapa no tenía (ni como punto): más divisiones dentro de los barrios grandes.
for (const { base, area } of areasOsm.values()) {
  if (esMunicipal([CAPITAL], base).barrios.length > 0) continue;
  agregar(base, area, 'poligono', 'osm');
}
const conContorno = nuevos.map((f) => f as Area);
for (const { base, area, fuente } of aproximar(sinContorno, conContorno, null, 300)) {
  // Sin salirse del barrio municipal que contiene el punto.
  const centro = turf.centroid(area).geometry.coordinates;
  const padre = municipales.find((m) => turf.booleanPointInPolygon(centro, m));
  agregar(base, (padre && interseccion(area, padre)) || area, 'aproximado', fuente);
}

const resto = interior.features.filter((f) => f.properties.localidad !== CAPITAL);
await writeFile('data/barrios-interior.geojson', JSON.stringify(aplicarContornos({ type: 'FeatureCollection', features: [...resto, ...nuevos] }, 'interior')) + '\n');
const cuenta = (tipo: string) => nuevos.filter((f) => f.properties.tipo === tipo).length;
console.log(`Capital: ${cuenta('poligono')} lugares con contorno de OSM y ${cuenta('aproximado')} aproximados.`);
