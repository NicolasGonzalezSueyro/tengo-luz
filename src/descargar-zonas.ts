import { readFile, writeFile } from 'node:fs/promises';
import type { Localidad } from './localidades.ts';
import { aplicarContornos } from './contornos.ts';

// Arma data/zonas.geojson: zonas APROXIMADAS que se marcan en el mapa cuando un corte no se puede ubicar por barrios.
// Se corre a mano (`npm run zonas`). Hay dos tipos:
//
// - "ruta": cortes de capital que EPEC describe por una ruta o camino ("zona rural sobre Ruta Nacional 9 hacia el
//   norte"). Tomamos el tramo de la ruta de OpenStreetMap y dibujamos un "corredor" de unos cientos de metros a cada
//   lado. Los tramos se eligieron ubicando las referencias del anuncio en un mapa (ej. el Km 13 del Camino a 60 Cuadras).
// - "localidad": las localidades de Gran Córdoba (las del resto de la provincia las agrega solo el lector, con
//   src/localidades.ts). EPEC las describe por calles o "en la localidad", sin barrios que
//   se puedan ubicar, así que se marca el límite del municipio entero, que da OpenStreetMap a través de Nominatim.
//
// Ninguna es el límite real del corte (EPEC no lo publica): son una referencia visual de dónde queda.
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/lookup';
const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };
const ARCHIVO = 'data/zonas.geojson';
const ANCHO_METROS = 450;

type Punto = [number, number]; // [longitud, latitud]

const ZONAS = [
  {
    nombre: 'Zona rural Ruta 9 Norte',
    // Se compara contra el texto normalizado del anuncio (minúsculas, sin tildes ni "de"/"del").
    patron: String.raw`\bruta (nacional )?9\b.*\bnorte\b|\bruta 9 norte\b`,
    descripcion: 'Zona rural a los costados de la Ruta Nacional 9, al norte de Guiñazú. El anuncio describe el corte por la ruta: el área marcada es una referencia aproximada.',
    // Tramo de la RN9 desde el límite norte de la ciudad hasta unos 7 km más al norte.
    filtro: 'way["highway"]["ref"~"^RN ?9$"](-31.312,-64.200,-31.250,-64.150)',
  },
  {
    nombre: 'Camino a 60 Cuadras (desde el Km 13)',
    patron: String.raw`\bcamino (a )?60 cuadras\b`,
    descripcion: 'Zona a los costados del Camino a 60 Cuadras, desde el Km 13 hacia el sur. El anuncio describe el corte por la ruta: el área marcada es una referencia aproximada.',
    // El Km 13 queda cerca de la latitud -31,536; tomamos unos 5 km hacia el sur.
    filtro: 'way["highway"]["name"="Camino a 60 Cuadras"](-31.580,-64.200,-31.534,-64.050)',
  },
];

// Localidades de Gran Córdoba (unos 40 km a la redonda), con su límite municipal en OpenStreetMap (número de relación).
// El patrón se busca en el título de la sección de la nota y en el texto del corte (ej. "Localidades de Alta Gracia…").
const LOCALIDADES = [
  { nombre: 'Villa Allende', relacion: 6091815, patron: String.raw`\bvilla allende\b` },
  { nombre: 'Mendiolaza', relacion: 9453753, patron: String.raw`\bmendiolaza\b` },
  { nombre: 'Unquillo', relacion: 8804980, patron: String.raw`\bunquillo\b` },
  { nombre: 'Río Ceballos', relacion: 9460381, patron: String.raw`\brio ceballos\b` },
  { nombre: 'Saldán', relacion: 9414254, patron: String.raw`\bsaldan\b` },
  { nombre: 'La Calera', relacion: 9435036, patron: String.raw`\bla calera\b` },
  { nombre: 'Malagueño', relacion: 9450679, patron: String.raw`\bmalagueno\b` },
  { nombre: 'Villa Carlos Paz', relacion: 2284280, patron: String.raw`\bcarlos paz\b` },
  { nombre: 'Alta Gracia', relacion: 9720880, patron: String.raw`\balta gracia\b` },
  { nombre: 'Estación Juárez Celman', relacion: 9427931, patron: String.raw`\bjuarez celman\b` },
  { nombre: 'Colonia Tirolesa', relacion: 9409810, patron: String.raw`\bcolonia tirolesa\b` },
];

type Geometria = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };

/** Los límites de todas las localidades en un solo pedido a Nominatim (pide no hacer más de uno por segundo). */
async function limitesDeLocalidades(): Promise<Map<number, Geometria>> {
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    osm_ids: LOCALIDADES.map((l) => `R${l.relacion}`).join(','),
    format: 'json',
    polygon_geojson: '1',
    polygon_threshold: '0.0003', // simplifica el contorno (unos 30 m de detalle): el archivo queda liviano
  }).toString();
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  const resultados = (await res.json()) as { osm_id: number; geojson: Geometria }[];
  return new Map(resultados.map((r) => [r.osm_id, r.geojson]));
}

/** Redondea las coordenadas a 5 decimales (~1 m), en cualquier nivel de anidado. */
export const redondear = (valor: unknown): unknown =>
  typeof valor === 'number' ? Math.round(valor * 1e5) / 1e5 : Array.isArray(valor) ? valor.map(redondear) : valor;

// Overpass es un servicio gratuito y compartido: a veces responde "ocupado" o limita consultas. Reintentamos con calma.
async function consultar(filtro: string, intentos = 5): Promise<Punto[]> {
  for (let intento = 1; ; intento++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: new URLSearchParams({ data: `[out:json][timeout:120];${filtro};out geom;` }),
      headers: IDENTIFICACION,
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      const { elements } = (await res.json()) as { elements: { geometry: { lat: number; lon: number }[] }[] };
      return elements.flatMap((e) => e.geometry.map((p): Punto => [p.lon, p.lat]));
    }
    if (intento === intentos || ![429, 502, 503, 504].includes(res.status)) throw new Error(`Overpass respondió ${res.status}`);
    console.warn(`Overpass respondió ${res.status}, reintento ${intento}/${intentos - 1} en ${intento * 20} segundos...`);
    await new Promise((r) => setTimeout(r, intento * 20_000));
  }
}

/** Un corredor alrededor de la ruta: rodeamos cada punto con un círculo y tomamos el contorno de todo eso. */
export function corredor(puntos: Punto[], metros: number): Punto[] {
  const alrededor = puntos.flatMap(([lon, lat]) => {
    const dLat = metros / 111_320;
    const dLon = metros / (111_320 * Math.cos((lat * Math.PI) / 180));
    return Array.from({ length: 12 }, (_, i): Punto => [lon + dLon * Math.cos((i * Math.PI) / 6), lat + dLat * Math.sin((i * Math.PI) / 6)]);
  });
  return envolventeConvexa(alrededor);
}

/** El contorno convexo de un conjunto de puntos (algoritmo "monotone chain"), cerrado como pide GeoJSON. */
export function envolventeConvexa(puntos: Punto[]): Punto[] {
  const ordenados = [...puntos].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const giro = (o: Punto, a: Punto, b: Punto) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const mitad = (lista: Punto[]) => {
    const casco: Punto[] = [];
    for (const p of lista) {
      while (casco.length >= 2 && giro(casco[casco.length - 2], casco[casco.length - 1], p) <= 0) casco.pop();
      casco.push(p);
    }
    casco.pop();
    return casco;
  };
  const contorno = [...mitad(ordenados), ...mitad([...ordenados].reverse())];
  return [...contorno, contorno[0]];
}

// Solo corre la descarga cuando se ejecuta este archivo, no cuando lo importan los tests.
if (import.meta.main) {
  const features = [];
  for (const zona of ZONAS) {
    const puntos = await consultar(zona.filtro);
    if (puntos.length < 2) throw new Error(`No encontré el tramo de ruta para "${zona.nombre}"`);
    const contorno = corredor(puntos, ANCHO_METROS).map(([lon, lat]): Punto => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    features.push({
      type: 'Feature',
      properties: { nombre: zona.nombre, tipo: 'ruta', patron: zona.patron, descripcion: zona.descripcion },
      geometry: { type: 'Polygon', coordinates: [contorno] },
    });
    console.log(`${zona.nombre}: ${puntos.length} puntos de ruta → contorno de ${contorno.length} vértices`);
  }
  const limites = await limitesDeLocalidades();
  for (const localidad of LOCALIDADES) {
    const limite = limites.get(localidad.relacion);
    if (!limite || !['Polygon', 'MultiPolygon'].includes(limite.type)) throw new Error(`No encontré el límite de ${localidad.nombre}`);
    features.push({
      type: 'Feature',
      properties: {
        nombre: localidad.nombre,
        tipo: 'localidad',
        patron: localidad.patron,
        osm: `R${localidad.relacion}`,
        descripcion: `El anuncio no detalla barrios de ${localidad.nombre}: se marca toda la localidad como referencia.`,
      },
      geometry: { type: limite.type, coordinates: redondear(limite.coordinates) },
    });
    console.log(`${localidad.nombre}: límite municipal (${limite.type})`);
  }
  // Las localidades del resto de la provincia las agrega el lector solo (src/localidades.ts): se conservan.
  const cargadas = new Set(LOCALIDADES.map((l) => `R${l.relacion}`));
  const anteriores = JSON.parse(await readFile(ARCHIVO, 'utf8').catch(() => '{"features":[]}')) as { features: Localidad[] };
  features.push(...anteriores.features.filter((f) => f.properties.tipo === 'localidad' && f.properties.osm && !cargadas.has(f.properties.osm)));
  await writeFile(ARCHIVO, JSON.stringify(aplicarContornos({ type: 'FeatureCollection', features }, 'zonas'), null, 1) + '\n');
  console.log(`Guardadas ${features.length} zonas aproximadas en ${ARCHIVO}`);
}
