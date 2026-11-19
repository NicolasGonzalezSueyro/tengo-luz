// @ts-check
// El "motor" del editor de contornos: dado el nombre de un lugar y su localidad, lo busca en todas las fuentes
// públicas y arma candidatos de contorno, de mejor a peor:
//   1. Capas oficiales de la Provincia (Mapas Córdoba, IDECOR): barrios de los municipios que los publican y loteos
//      aprobados de la Municipalidad de Córdoba.
//   2. OpenStreetMap: áreas con ese nombre (barrios, zonas residenciales) por Overpass y Nominatim.
//   3. Si solo aparece como un punto (OpenStreetMap o Georef, la base oficial de asentamientos): un contorno armado
//      con las manzanas oficiales de alrededor (~250 m), que hay que revisar.
// Todo pasa en el navegador del admin (las funciones de Cloudflare gratis no alcanzan para la geometría).
// Usa Turf (cargado como "turf" global en admin-contornos.html).
// Turf viene como script global (sin tipos). Se toma recién al usarlo: los tests importan este archivo sin él.
const turf = () => /** @type {any} */ (globalThis).turf;

import { BARRIOS_OFICIALES, LOTEOS_CAPITAL } from './capas-oficiales.js';

const IDECOR = 'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://lambert.openstreetmap.de/api/interpreter'];
const CAPITAL = 'Córdoba';

/**
 * @typedef {{ type: 'Polygon' | 'MultiPolygon', coordinates: any }} Area
 * @typedef {{ fuente: string, nombre: string, geometria: Area, aproximado: boolean, puntaje: number }} Candidato
 * @typedef {[number, number, number, number]} Caja oeste, sur, este, norte
 */

/** Minúsculas, sin tildes ni signos, sin "barrio", "loteo", "country"… adelante. @param {string} texto */
export function clave(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^((barrio (privado|cerrado)|barrios?|b|bo|loteo|country|club de campo|urbanizacion|complejo|cooperativa|coop|villa de emergencia) )+/, '');
}

/** Qué tan bien un nombre encontrado corresponde al buscado: 3 igual, 2 uno contiene al otro, 0 nada. @param {string} encontrado @param {string} buscado */
export function parecido(encontrado, buscado) {
  const [a, b] = [clave(encontrado), clave(buscado)];
  if (!a || !b) return 0;
  if (a === b) return 3;
  const contiene = (/** @type {string} */ x, /** @type {string} */ y) => ` ${x} `.includes(` ${y} `);
  return contiene(a, b) || contiene(b, a) ? 2 : 0;
}

/** La palabra más larga, con las vocales como comodín de una letra (para buscar sin que importen las tildes). @param {string} nombre */
function pista(nombre) {
  const larga = clave(nombre).split(' ').sort((x, y) => y.length - x.length)[0] ?? '';
  return larga.replace(/[aeiou]/g, '_').replace(/n/g, '_');
}

/**
 * Pide un JSON y, si falla o tarda, devuelve null (una fuente caída no frena a las demás).
 * @param {string | URL} url @param {RequestInit} [opciones] @param {number} [plazo] milisegundos
 */
async function pedirJson(url, opciones = {}, plazo = 25_000) {
  try {
    const res = await fetch(url, { ...opciones, signal: AbortSignal.timeout(plazo) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Una capa WFS de IDECOR filtrada (CQL), en latitud y longitud. @param {string} capa @param {string} filtro */
async function idecor(capa, filtro) {
  const url = new URL(IDECOR);
  url.search = new URLSearchParams({
    service: 'WFS', version: '1.0.0', request: 'GetFeature', typeName: `idecor:${capa}`, outputFormat: 'application/json', srsName: 'EPSG:4326', CQL_FILTER: filtro,
  }).toString();
  return (await pedirJson(url))?.features ?? [];
}

/** @param {string} nombre @param {string} localidad @returns {Promise<Candidato[]>} */
async function oficiales(nombre, localidad) {
  const p = pista(nombre);
  if (p.length < 3) return [];
  const capas = localidad === CAPITAL
    ? LOTEOS_CAPITAL.map(({ capa, campos }) => ({ capa, campos }))
    : BARRIOS_OFICIALES[localidad] ? [{ capa: BARRIOS_OFICIALES[localidad].capa, campos: [BARRIOS_OFICIALES[localidad].campo] }] : [];
  const listas = await Promise.all(capas.map(({ capa, campos }) =>
    idecor(capa, campos.map((/** @type {string} */ c) => `${c} ILIKE '%${p}%'`).join(' OR ')).then((/** @type {any[]} */ fs) => fs.map((f) => ({ f, campos })))));
  return listas.flat().flatMap(({ f, campos }) => {
    if (!f.geometry || !/Polygon$/.test(f.geometry.type)) return [];
    const nombres = campos.map((/** @type {string} */ c) => String(f.properties[c] ?? '')).filter((/** @type {string} */ n) => n && n !== 'null');
    const puntaje = Math.max(0, ...nombres.map((n) => parecido(n, nombre)));
    return puntaje > 0 ? [{ fuente: localidad === CAPITAL ? 'Loteo de la Municipalidad (IDECOR)' : `Barrios oficiales de ${localidad} (IDECOR)`, nombre: nombres[nombres.length - 1] ?? nombres[0], geometria: f.geometry, aproximado: false, puntaje: puntaje + 2 }] : [];
  });
}

/** Un nombre como expresión regular de Overpass que no distingue tildes. @param {string} nombre */
function patron(nombre) {
  const larga = clave(nombre).split(' ').sort((x, y) => y.length - x.length)[0] ?? '';
  const letras = /** @type {Record<string, string>} */ ({ a: '[aáAÁ]', e: '[eéEÉ]', i: '[iíIÍ]', o: '[oóOÓ]', u: '[uúüUÚÜ]', n: '[nñNÑ]' });
  return larga.split('').map((l) => letras[l] ?? `[${l}${l.toUpperCase()}]`).join('');
}

/** @param {string} nombre @param {Caja} caja @returns {Promise<{ candidatos: Candidato[], puntos: { nombre: string, punto: [number, number], fuente: string }[] }>} */
async function deOpenStreetMap(nombre, caja) {
  const [o, s, e, n] = caja;
  const filtro = `["name"~"${patron(nombre)}"](${s},${o},${n},${e})`;
  const consulta = `[out:json][timeout:25];(way${filtro}["landuse"="residential"];way${filtro}["place"];node${filtro}["place"];);out geom;`;
  /** @type {any} */
  let datos = null;
  for (const servidor of OVERPASS) {
    // Overpass es gratuito y a veces está saturado: 12 segundos por servidor, y si no, sigue sin él (Nominatim también
    // tiene las áreas de OpenStreetMap).
    datos = await pedirJson(servidor, { method: 'POST', body: new URLSearchParams({ data: consulta }) }, 12_000);
    if (datos) break;
  }
  /** @type {Candidato[]} */
  const candidatos = [];
  const puntos = [];
  for (const el of datos?.elements ?? []) {
    const nom = el.tags?.name ?? '';
    const puntaje = parecido(nom, nombre);
    if (!puntaje) continue;
    if (el.type === 'node') {
      puntos.push({ nombre: nom, punto: /** @type {[number, number]} */ ([el.lon, el.lat]), fuente: 'OpenStreetMap (punto)' });
    } else if (el.geometry?.length >= 4) {
      const anillo = el.geometry.map((/** @type {any} */ p) => [p.lon, p.lat]);
      const [a, z] = [anillo[0], anillo.at(-1)];
      if (a[0] === z[0] && a[1] === z[1]) candidatos.push({ fuente: 'OpenStreetMap', nombre: nom, geometria: { type: 'Polygon', coordinates: [anillo] }, aproximado: false, puntaje: puntaje + 1 });
    }
  }
  return { candidatos, puntos };
}

/** @param {string} nombre @param {string} localidad @param {Caja} caja */
async function deNominatim(nombre, localidad, caja) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    q: `${nombre}, ${localidad === CAPITAL ? 'Córdoba' : localidad}, Córdoba, Argentina`, format: 'jsonv2', polygon_geojson: '1', limit: '6',
    countrycodes: 'ar', viewbox: caja.join(','), bounded: '1', 'accept-language': 'es',
  }).toString();
  /** @type {Candidato[]} */
  const candidatos = [];
  const puntos = [];
  for (const r of (await pedirJson(url)) ?? []) {
    const nom = r.name || String(r.display_name).split(',')[0];
    const puntaje = parecido(nom, nombre);
    // Solo lugares y zonas: una calle, una escuela o un comercio con ese nombre ("José Hernández") no son el barrio.
    if (!puntaje || !['place', 'landuse'].includes(r.category)) continue;
    if (/Polygon$/.test(r.geojson?.type)) {
      candidatos.push({ fuente: 'OpenStreetMap (Nominatim)', nombre: nom, geometria: r.geojson, aproximado: false, puntaje });
    } else {
      puntos.push({ nombre: nom, punto: /** @type {[number, number]} */ ([Number(r.lon), Number(r.lat)]), fuente: 'OpenStreetMap (punto)' });
    }
  }
  return { candidatos, puntos };
}

/** @param {string} nombre @param {Caja} caja */
async function deGeoref(nombre, caja) {
  const url = new URL('https://apis.datos.gob.ar/georef/api/asentamientos');
  url.search = new URLSearchParams({ nombre, provincia: 'cordoba', max: '5' }).toString();
  const [o, s, e, n] = caja;
  return ((await pedirJson(url))?.asentamientos ?? [])
    .filter((/** @type {any} */ a) => parecido(a.nombre, nombre) >= 2 && a.centroide.lon >= o && a.centroide.lon <= e && a.centroide.lat >= s && a.centroide.lat <= n)
    .map((/** @type {any} */ a) => ({ nombre: a.nombre, punto: /** @type {[number, number]} */ ([a.centroide.lon, a.centroide.lat]), fuente: 'Georef (asentamientos oficiales)' }));
}

/**
 * Un contorno aproximado alrededor de un punto: las manzanas oficiales cuyo centro queda a menos de `metros`, unidas
 * (se agranda y achica 9 m para que las calles de adentro queden incluidas). Null si no hay manzanas ahí.
 * @param {[number, number]} punto @param {number} [metros]
 * @returns {Promise<Area | null>}
 */
export async function contornoConManzanas(punto, metros = 250) {
  const [lon, lat] = punto;
  const d = metros / 100_000 + 0.002;
  const manzanas = (await pedirJson(`${IDECOR}?service=WFS&version=1.0.0&request=GetFeature&typeName=idecor:manzana&outputFormat=application/json`
    + `&srsName=EPSG:4326&bbox=${lon - d},${lat - d},${lon + d},${lat + d},EPSG:4326`))?.features ?? [];
  const t = turf();
  const cerca = manzanas.filter((/** @type {any} */ m) => m.geometry && t.distance(t.point(punto), t.centroid(m), { units: 'meters' }) <= metros);
  if (cerca.length === 0) return null;
  /** @type {any} */
  let union = null;
  for (const m of cerca) {
    const agrandada = t.buffer(m, 9, { units: 'meters' });
    try {
      union = union ? t.union(t.featureCollection([union, agrandada])) : agrandada;
    } catch {
      // una manzana con la geometría rota: se saltea
    }
  }
  const achicada = union && t.buffer(union, -9, { units: 'meters' });
  return achicada ? t.simplify(achicada, { tolerance: 0.00002 }).geometry : null;
}

/**
 * Busca el lugar en todas las fuentes. Devuelve los candidatos de mejor a peor (los oficiales primero; los armados con
 * manzanas, al final y marcados como aproximados).
 * @param {string} nombre @param {string} localidad @param {Caja} caja la zona donde buscar (la localidad, un poco agrandada)
 * @param {(texto: string) => void} [avance]
 * @returns {Promise<Candidato[]>}
 */
export async function ubicarLugar(nombre, localidad, caja, avance = () => {}) {
  avance('Buscando en la Provincia, la Municipalidad, OpenStreetMap y Georef…');
  const [deIdecor, osm, nominatim, georef] = await Promise.all([
    oficiales(nombre, localidad), deOpenStreetMap(nombre, caja), deNominatim(nombre, localidad, caja), deGeoref(nombre, caja),
  ]);
  const candidatos = [...deIdecor, ...osm.candidatos, ...nominatim.candidatos];
  // Solo puntos: se arma el contorno con las manzanas de alrededor del mejor punto.
  const puntos = [...osm.puntos, ...nominatim.puntos, ...georef];
  if (puntos.length > 0) {
    avance('Armando un contorno con las manzanas oficiales de alrededor…');
    const punto = puntos.sort((a, b) => parecido(b.nombre, nombre) - parecido(a.nombre, nombre))[0];
    const geometria = await contornoConManzanas(punto.punto);
    if (geometria) candidatos.push({ fuente: `${punto.fuente}, con las manzanas de alrededor`, nombre: punto.nombre, geometria, aproximado: true, puntaje: 0 });
  }
  // Sin repetidos (la misma área por dos caminos) y de mejor a peor.
  const vistos = new Set();
  return candidatos
    .sort((a, b) => b.puntaje - a.puntaje)
    .filter((c) => {
      const huella = JSON.stringify(turf().bbox(c.geometria).map((/** @type {number} */ x) => x.toFixed(3)));
      if (vistos.has(huella)) return false;
      vistos.add(huella);
      return true;
    });
}
