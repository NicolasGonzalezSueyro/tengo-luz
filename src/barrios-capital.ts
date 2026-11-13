// Contornos para los lugares de capital que no están en el mapa municipal (npm run barrios-capital).
//
// El mapa de la Municipalidad tiene ~485 barrios, pero adentro de algunos hay countries y loteos que EPEC nombra
// por separado (en Valle Escondido: Los Cielos, Las Terrazas, La Reserva…). Hasta ahora eran solo un punto.
// 1. Baja de OpenStreetMap las zonas residenciales y barrios con nombre de la ciudad: si el lugar tiene contorno
//    ahí, se usa ese (y también se suman los que no tenía el mapa: más divisiones para reconocer).
//    Antes que OSM, los loteos aprobados y autorizados por la Municipalidad (Mapas Córdoba, IDECOR): contorno oficial.
// 2. Los puntos de OSM sin contorno y los nombres de los cortes que no se encuentran (buscados en Nominatim)
//    reciben un contorno APROXIMADO chico (hasta 300 m, repartido con los vecinos), sin salirse del barrio
//    municipal que los contiene, cortado por las avenidas (no cruza Mahatma Gandhi ni ninguna otra) y ajustado a
//    las manzanas oficiales de la Provincia, así el borde sigue las calles.
// Quedan en data/barrios-interior.geojson con localidad "Córdoba" (el lector y la página los tratan igual que al
// resto). Correr después de `npm run barrios-interior`, que reescribe ese archivo.
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as turf from '@turf/turf';
import type { Position } from 'geojson';
import { crearUbicador, esDescripcion, normalizar } from './barrios.ts';
import {
  aliviar, aproximar, areaDe, consultarOverpass, diferencia, enTitulo, interseccion, km2, SERVIDORES, unir,
  claveDeLugar, esVariante, sinEncimar, sinRepetidos, type Area, type BarrioInterior, type ElementoOsm, type Semilla,
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
const buscarMunicipal = crearBuscadorDeBarrios(nombresMunicipales.map((n) => ({ nombre: n, base: n, localidad: CAPITAL })));
// "Cooperativa 16 de Noviembre" y "16 de Noviembre": con la misma clave es el mismo barrio, no se dibuja otro encima.
const clavesMunicipales = new Set(nombresMunicipales.map(claveDeLugar));
const esMunicipal = (localidades: string[], nombre: string) =>
  (clavesMunicipales.has(claveDeLugar(nombre)) ? { barrios: [nombre] } : buscarMunicipal(localidades, nombre));
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

// Los loteos de la Municipalidad (con caché en disco): nombre oficial y de fantasía ("Urbanización Siete Soles").
const IDECOR = 'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs';
async function bajarIdecor(capa: string, extra: Record<string, string> = {}, archivo = `${CACHE}/idecor-${capa}.json`) {
  const guardado = await readFile(archivo, 'utf8').catch(() => null);
  if (guardado) return JSON.parse(guardado) as { features: (Area & { properties: Record<string, unknown> })[] };
  const url = new URL(IDECOR);
  url.search = new URLSearchParams({
    service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: `idecor:${capa}`, outputFormat: 'application/json', srsName: 'EPSG:4326', ...extra,
  }).toString();
  await pausa(300); // sin apurar al servidor de la Provincia
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Mapas Córdoba respondió ${res.status} para ${capa}`);
  const datos = await res.json();
  await mkdir(dirname(archivo), { recursive: true });
  await writeFile(archivo, JSON.stringify(datos));
  return datos as { features: (Area & { properties: Record<string, unknown> })[] };
}
const sinPrefijoOficial = (n: string) => sinPrefijo(enTitulo(n).replace(/^(urbanizaci[oó]n|loteo|barrio|complejo habitacional)\s+/i, ''));
const loteos = new Map<string, { base: string; area: Area }>();
for (const capa of ['loteos_muni_aprobados', 'loteos_muni_autorizados']) {
  for (const f of (await bajarIdecor(capa)).features) {
    if (!f.geometry) continue;
    const area = { type: 'Feature', properties: {}, geometry: f.geometry } as Area;
    if (km2(area) < 0.003 || km2(area) > 3) continue;
    // El nombre de fantasía es como lo conoce la gente; el oficial también se guarda para encontrarlo.
    const nombres = [f.properties.nombfant, f.properties.nombre].map((n) => sinPrefijoOficial(String(n ?? ''))).filter((n) => n.length >= 3 && n !== 'None');
    for (const base of nombres) if (!loteos.has(claveDeBarrio(base))) loteos.set(claveDeBarrio(base), { base: nombres[0], area });
  }
}

// Las avenidas y calles principales: un contorno aproximado no las cruza.
const archivoAvenidas = `${CACHE}/osm-capital-avenidas.json`;
let avenidas = JSON.parse(await readFile(archivoAvenidas, 'utf8').catch(() => 'null')) as ElementoOsm[] | null;
if (!avenidas) {
  avenidas = await consultarOverpass(`[out:json][timeout:180];
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${CAJA});out geom qt;`, 'avenidas de Córdoba', SERVIDORES[1]);
  await writeFile(archivoAvenidas, JSON.stringify(avenidas));
}
const lineasAvenidas = avenidas.filter((e) => (e.geometry?.length ?? 0) >= 2).map((e) => turf.lineString(e.geometry!.map((p) => [p.lon, p.lat])));

/** El pedazo del área del lado de la avenida donde está el lugar. */
function cortarPorAvenidas(area: Area, punto: Position): Area {
  const [o, s, e, n] = turf.bbox(area);
  const cerca = lineasAvenidas.filter((l) => {
    const [lo, ls, le, ln] = turf.bbox(l);
    return lo <= e && le >= o && ls <= n && ln >= s;
  });
  if (cerca.length === 0) return area;
  const franjas = cerca.map((l) => turf.buffer(l, 6, { units: 'meters' }) as Area | undefined).filter((f): f is Area => Boolean(f));
  const zona = unir(franjas);
  const recortada = zona ? diferencia(area, zona) : area;
  if (!recortada) return area;
  const partes = turf.flatten(recortada).features as Area[];
  return partes.find((p) => turf.booleanPointInPolygon(punto, p))
    ?? partes.sort((a, b) => turf.distance(punto, turf.centroid(a)) - turf.distance(punto, turf.centroid(b)))[0] ?? area;
}

/** El área ajustada a las manzanas oficiales que caen adentro, con las calles internas cerradas. */
async function ajustarAManzanas(area: Area, nombre: string): Promise<Area> {
  const [o, s, e, n] = turf.bbox(area);
  const archivo = `${CACHE}/manzanas/${claveDeBarrio(nombre).replace(/\s+/g, '-')}.json`;
  const manzanas = await bajarIdecor('manzana', { bbox: `${o},${s},${e},${n},EPSG:4326` }, archivo).catch(() => ({ features: [] as Area[] }));
  const adentro = manzanas.features.filter((m) => m.geometry && turf.booleanPointInPolygon(turf.pointOnFeature(m), area));
  if (adentro.length === 0) return area;
  // Se agranda 9 m y se achica 9 m: las calles entre manzanas quedan adentro y el borde sigue la línea de las cuadras.
  const juntas = unir(adentro.map((m) => turf.buffer(m, 9, { units: 'meters' }) as Area));
  const ajustada = juntas && (turf.buffer(juntas, -9, { units: 'meters' }) as Area | undefined);
  return ajustada ?? area;
}

// 2. Lo que hay que enmarcar: los puntos del mapa y los nombres de los cortes que no aparecen en ningún lado.
const semillas: Semilla[] = mapa.features
  .filter((f) => f.properties.tipo === 'punto' && f.properties.nombre)
  .map((f) => ({ base: f.properties.nombre!, punto: f.geometry.coordinates as Position, fuente: 'osm' as const }));

const faltan = new Set<string>();
const nombradosEnCapital = new Set<string>(); // lo que EPEC nombra en sus cortes de capital y no es un barrio municipal
for (const c of cortes.filter((c) => (c.localidad ?? CAPITAL) === CAPITAL)) {
  for (const pedazo of ubicar(c.zona).sinUbicar) {
    nombradosEnCapital.add(claveDeLugar(pedazo));
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
// Nada fuera del radio urbano oficial de capital (Lomas Sur, Tejas Tres… son de Villa Allende o Malagueño), ni nombres
// que no son lugares ("Manzana 4", "Asentamiento" a secas).
const radiosProvincia = JSON.parse(await readFile('.cache/barrios-interior/idecor-radios_urbanos.json', 'utf8').catch(() => '{"features":[]}')) as { features: (Area & { properties: { nombre?: string } })[] };
const radioCapital = radiosProvincia.features.filter((r) => r.geometry && /^c[oó]rdoba$/i.test(r.properties.nombre ?? ''));
const enCapital = (a: Area) => radioCapital.length === 0 || radioCapital.some((r) => turf.booleanPointInPolygon(turf.pointOnFeature(a), r));
// Tampoco shoppings ("DUO - Distrito Córdoba Shopping"): OSM los marca como zona con nombre, pero no son barrios.
const BASURA = /^(manzana|mz\.?|lote|parcela)\b|^asentamiento$|\bshopping\b/i;
const nuevos: BarrioInterior[] = [];
const vistos = new Set<string>();
const agregar = (base: string, area: Area, tipo: 'poligono' | 'aproximado', fuente: 'osm' | 'nominatim' | 'municipio') => {
  const clave = claveDeBarrio(base);
  // Menos de 500 m² (un aproximado que quedó en nada entre avenidas, como "Aguas Cordobesas") no es un lugar.
  if (vistos.has(clave) || BASURA.test(base.trim()) || !enCapital(area) || km2(area) < 0.0005) return;
  vistos.add(clave);
  nuevos.push({ ...aliviar(area), properties: { nombre: base, base, localidad: CAPITAL, tipo, fuente } } as BarrioInterior);
};
const sinContorno: Semilla[] = [];
// "Alejandro Carbó" con el pin adentro del barrio "Carbo", "Argüello Lourdes" en "Lourdes": es el mismo barrio con otro
// nombre. No se dibuja otro encima: queda como alias (data/alias-barrios.json) y el corte pinta el barrio oficial.
// Las partes de un barrio (Ampliación, Anexo, Bajo, IPV…) sí son divisiones.
// Solo cuenta como el mismo nombre si lo que sobra son palabras genéricas, títulos o nombres de pila ("Alejandro
// Carbó" y "Carbo", "Parque Liceo Primera Sección" y "Parque Liceo 1° Sección"). Nunca si sobra algo que describe una
// parte ("Brisas de Manantiales" no es "Manantiales II", "Talleres Este" no es "Talleres") ni si cambia un número.
const PARTE = /^(ampliaci[oó]n|anexo|bajo|alto|nuevo|nueva|sector|secci[oó]n|ipv|cooperativa|coop|country|barrio cerrado)\b/i;
const aliasNuevos: Record<string, string> = {};
for (const s of semillas) {
  // "Country La Reserva" ya está en el mapa municipal como "La Reserva".
  if (esMunicipal([CAPITAL], sinPrefijo(s.base)).barrios.length > 0) continue;
  const padre = municipales.find((m) => turf.booleanPointInPolygon(s.punto, m));
  if (padre && !PARTE.test(s.base) && enCapital(turf.point(s.punto) as unknown as Area) && esVariante(s.base, padre.properties.nombre!)) {
    if (!(s.base in alias)) aliasNuevos[s.base] = padre.properties.nombre!;
    continue;
  }
  const cerca2km = (a: Area) => turf.booleanPointInPolygon(s.punto, a) || turf.distance(s.punto, turf.centroid(a), { units: 'kilometers' }) < 2;
  const loteo = loteos.get(claveDeBarrio(sinPrefijoOficial(s.base)));
  if (loteo && cerca2km(loteo.area)) {
    agregar(s.base, loteo.area, 'poligono', 'municipio');
    continue;
  }
  const osm = areasOsm.get(claveDeBarrio(sinPrefijo(s.base)));
  const cerca = osm && (turf.booleanPointInPolygon(s.punto, osm.area)
    || turf.distance(s.punto, turf.centroid(osm.area), { units: 'kilometers' }) < 1.5);
  if (cerca) agregar(s.base, osm.area, 'poligono', 'osm');
  else sinContorno.push(s);
}
// Los loteos y las zonas de OSM que el mapa no tenía (ni como punto): más divisiones dentro de los barrios grandes.
// Un loteo o un área de OSM que es el barrio oficial con otro nombre ("Matienzo" y "Tte. Benjamin Matienzo") tampoco.
const esElBarrioOficial = (base: string, area: Area) => {
  const padre = municipales.find((m) => turf.booleanPointInPolygon(turf.pointOnFeature(area), m));
  return Boolean(padre) && !PARTE.test(base) && esVariante(base, padre!.properties.nombre!);
};
for (const { base, area } of loteos.values()) {
  if (esMunicipal([CAPITAL], base).barrios.length > 0 || esElBarrioOficial(base, area)) continue;
  agregar(base, area, 'poligono', 'municipio');
}
for (const { base, area } of areasOsm.values()) {
  if (esMunicipal([CAPITAL], base).barrios.length > 0 || esElBarrioOficial(base, area)) continue;
  agregar(base, area, 'poligono', 'osm');
}
const conContorno = nuevos.map((f) => f as Area);
const aproximados = aproximar(sinContorno, conContorno, null, 300);
for (const [i, { base, area, fuente }] of aproximados.entries()) {
  const punto = sinContorno[i].punto;
  // Sin salirse del barrio municipal que contiene el punto, sin cruzar avenidas y siguiendo las manzanas.
  const padre = municipales.find((m) => turf.booleanPointInPolygon(punto, m));
  const enElBarrio = (padre && interseccion(area, padre)) || area;
  const ajustada = await ajustarAManzanas(cortarPorAvenidas(enElBarrio, punto), base);
  agregar(base, cortarPorAvenidas(ajustada, punto), 'aproximado', fuente);
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${aproximados.length} aproximados ajustados a las manzanas`);
}

if (Object.keys(aliasNuevos).length > 0) {
  const todos = { ...alias, ...aliasNuevos };
  const ordenados = Object.fromEntries(Object.entries(todos).sort(([a], [b]) => a.localeCompare(b, 'es')));
  await writeFile('data/alias-barrios.json', JSON.stringify(ordenados, null, 2) + '\n');
  console.log(`🔗 ${Object.keys(aliasNuevos).length} alias nuevos (mismo barrio con otro nombre): ${Object.entries(aliasNuevos).map(([a, b]) => `${a} → ${b}`).join(', ')}`);
}
const resto = interior.features.filter((f) => f.properties.localidad !== CAPITAL);
const conManuales = aplicarContornos({ type: 'FeatureCollection', features: [...resto, ...nuevos] }, 'interior');
const finales = sinRepetidos(conManuales.features, undefined, nombradosEnCapital);
// Una división de capital que está casi toda (60 % o más) adentro de un barrio oficial se recorta a ese barrio: lo que
// se sale es un borde mal puesto. Las que cruzan varios barrios quedan como están. Y entre ellas no se pisan a medias.
const deCapital = finales.filter((f) => f.properties.localidad === CAPITAL);
let recortadas = 0;
for (const f of deCapital) {
  const area = f as Area;
  const total = km2(area);
  for (const padre of municipales) {
    const adentro = interseccion(area, padre);
    if (!adentro || km2(adentro) < 0.6 * total) continue;
    if (km2(adentro) < 0.98 * total) {
      f.geometry = aliviar(adentro).geometry as never;
      recortadas++;
    }
    break;
  }
}
sinEncimar(deCapital);
console.log(`✂️  ${recortadas} divisiones de capital recortadas a su barrio oficial.`);
await writeFile('data/barrios-interior.geojson', JSON.stringify({ type: 'FeatureCollection', features: finales }) + '\n');
const cuenta = (tipo: string) => nuevos.filter((f) => f.properties.tipo === tipo).length;
console.log(`Capital: ${cuenta('poligono')} lugares con contorno (oficial u OSM) y ${cuenta('aproximado')} aproximados.`);
