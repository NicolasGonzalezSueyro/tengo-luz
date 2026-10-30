import { writeFile } from 'node:fs/promises';
import { normalizar } from './barrios.ts';

// Arma data/barrios.geojson, el mapa de barrios de Córdoba capital. Se corre a mano de vez en cuando
// (`npm run barrios`): los límites de los barrios casi no cambian.
//
// - Polígonos: la capa oficial de barrios de la Municipalidad de Córdoba (servicio público de ArcGIS).
// - Puntos: lugares con nombre de OpenStreetMap que la Municipalidad no tiene (ej. "La Favela" o loteos nuevos).
//   Solo sabemos dónde quedan, no su forma, así que el mapa los muestra como un círculo.
// - Nombres: la Municipalidad los publica en MAYÚSCULAS y sin tildes; si OSM tiene el mismo barrio, usamos
//   su nombre ("Argüello" en vez de "ARGUELLO").

const MUNICIPALIDAD = 'https://services6.arcgis.com/Eop4lDCWqKLCYmkS/arcgis/rest/services/Barrios_filtro/FeatureServer/0/query';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MUNICIPIO_CORDOBA_OSM = 5167559; // id de la relación de OSM del municipio
const ARCHIVO = 'data/barrios.geojson';
const HEADERS = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };

type Geometria = { type: string; coordinates: unknown };
type ElementoOsm = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: Record<string, string> };

async function descargarMunicipalidad(): Promise<{ id: number; nombre: string; geometry: Geometria }[]> {
  const parametros = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,nombre',
    outSR: '4326', // latitud y longitud, lo que usan los mapas web
    geometryPrecision: '5', // ~1 metro: suficiente para un mapa y achica el archivo
    f: 'geojson',
  });
  const res = await fetch(`${MUNICIPALIDAD}?${parametros}`, { headers: HEADERS, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`La Municipalidad respondió ${res.status}`);
  const datos = await res.json();
  if (datos.properties?.exceededTransferLimit) throw new Error('La Municipalidad cortó la respuesta: hay que pedir los barrios en partes');
  return datos.features.map((f: { properties: { OBJECTID: number; nombre: string }; geometry: Geometria }) => ({
    id: f.properties.OBJECTID,
    nombre: f.properties.nombre,
    geometry: f.geometry,
  }));
}

// Overpass es un servicio gratuito y compartido: a veces responde "ocupado" (429, 502, 504). Reintentamos con calma.
async function descargarOsm(intentos = 4): Promise<ElementoOsm[]> {
  const consulta = `[out:json][timeout:180];
area(${3_600_000_000 + MUNICIPIO_CORDOBA_OSM})->.cordoba;
( rel(area.cordoba)["boundary"="administrative"]["admin_level"="9"];
  nwr(area.cordoba)["place"~"^(suburb|neighbourhood|quarter)$"]["name"]; );
out center tags;`;
  for (let intento = 1; ; intento++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: new URLSearchParams({ data: consulta }),
      headers: HEADERS,
      signal: AbortSignal.timeout(300_000),
    });
    if (res.ok) return (await res.json()).elements;
    if (intento === intentos || ![429, 502, 503, 504].includes(res.status)) throw new Error(`Overpass respondió ${res.status}`);
    console.warn(`Overpass respondió ${res.status}, reintento ${intento}/${intentos - 1} en ${intento * 20} segundos...`);
    await new Promise((r) => setTimeout(r, intento * 20_000));
  }
}

const CONECTORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);

/** "VILLA GENERAL URQUIZA" → "Villa General Urquiza" (para los que OSM no tiene con tildes). */
function enTitulo(nombre: string): string {
  return nombre
    .toLowerCase()
    .split(' ')
    .map((p, i) => {
      if (/^(i|ii|iii|iv|v|vi)$/.test(p)) return p.toUpperCase(); // números romanos: "Manantiales II"
      if (i > 0 && CONECTORES.has(p)) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
}

const [municipales, osm] = await Promise.all([descargarMunicipalidad(), descargarOsm()]);
if (municipales.length < 400) throw new Error(`Solo llegaron ${municipales.length} barrios de la Municipalidad; algo falló.`);

const nombreOsm = new Map<string, string>();
for (const e of osm) if (!nombreOsm.has(normalizar(e.tags.name))) nombreOsm.set(normalizar(e.tags.name), e.tags.name);

const poligonos = municipales.map((b) => ({
  type: 'Feature' as const,
  properties: {
    id: `municipalidad/${b.id}`,
    // "SD" = sin dato: hay algunos polígonos sin nombre. Se dibujan, pero no se pueden asociar a un corte.
    nombre: b.nombre === 'SD' ? null : (nombreOsm.get(normalizar(b.nombre)) ?? enTitulo(b.nombre)),
    tipo: 'poligono',
    fuente: 'municipalidad',
  },
  geometry: b.geometry,
}));

const yaEstan = new Set(municipales.map((b) => normalizar(b.nombre)));
const puntos = osm.flatMap((e) => {
  const clave = normalizar(e.tags.name);
  if (yaEstan.has(clave)) return [];
  yaEstan.add(clave);
  const lugar = e.center ?? { lat: e.lat!, lon: e.lon! };
  return [{
    type: 'Feature' as const,
    properties: { id: `osm/${e.type}/${e.id}`, nombre: e.tags.name, tipo: 'punto', fuente: 'osm' },
    geometry: { type: 'Point', coordinates: [lugar.lon, lugar.lat].map((c) => Math.round(c * 1e5) / 1e5) },
  }];
});

const barrios = [...poligonos, ...puntos].sort((a, b) => (a.properties.nombre ?? '').localeCompare(b.properties.nombre ?? '', 'es'));
await writeFile(ARCHIVO, JSON.stringify({ type: 'FeatureCollection', features: barrios }) + '\n');
console.log(`Guardados ${poligonos.length} barrios de la Municipalidad y ${puntos.length} puntos de OSM en ${ARCHIVO}`);
