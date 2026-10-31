import { writeFile } from 'node:fs/promises';

// Arma data/zonas.geojson: zonas APROXIMADAS para los cortes que EPEC describe por una ruta o camino
// en vez de por barrios (ej. "zona rural sobre Ruta Nacional 9 hacia el norte"). Se corre a mano (`npm run zonas`).
//
// Para cada zona tomamos el tramo de la ruta de OpenStreetMap y dibujamos un "corredor" de unos cientos de metros
// a cada lado. No es el límite real del corte (EPEC no lo publica), solo una referencia visual de dónde queda.
// Los tramos se eligieron ubicando las referencias del anuncio en un mapa (ej. el Km 13 del Camino a 60 Cuadras).
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ARCHIVO = 'data/zonas.geojson';
const ANCHO_METROS = 450;

type Punto = [number, number]; // [longitud, latitud]

const ZONAS = [
  {
    nombre: 'Zona rural Ruta 9 Norte',
    // Se compara contra el texto normalizado del anuncio (minúsculas, sin tildes ni "de"/"del").
    patron: String.raw`\bruta (nacional )?9\b.*\bnorte\b|\bruta 9 norte\b`,
    descripcion: 'Zona rural a los costados de la Ruta Nacional 9, al norte de Guiñazú.',
    // Tramo de la RN9 desde el límite norte de la ciudad hasta unos 7 km más al norte.
    filtro: 'way["highway"]["ref"~"^RN ?9$"](-31.312,-64.200,-31.250,-64.150)',
  },
  {
    nombre: 'Camino a 60 Cuadras (desde el Km 13)',
    patron: String.raw`\bcamino (a )?60 cuadras\b`,
    descripcion: 'Zona a los costados del Camino a 60 Cuadras, desde el Km 13 hacia el sur.',
    // El Km 13 queda cerca de la latitud -31,536; tomamos unos 5 km hacia el sur.
    filtro: 'way["highway"]["name"="Camino a 60 Cuadras"](-31.580,-64.200,-31.534,-64.050)',
  },
];

// Overpass es un servicio gratuito y compartido: a veces responde "ocupado" o limita consultas. Reintentamos con calma.
async function consultar(filtro: string, intentos = 5): Promise<Punto[]> {
  for (let intento = 1; ; intento++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: new URLSearchParams({ data: `[out:json][timeout:120];${filtro};out geom;` }),
      headers: { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' },
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
      properties: { nombre: zona.nombre, patron: zona.patron, descripcion: zona.descripcion },
      geometry: { type: 'Polygon', coordinates: [contorno] },
    });
    console.log(`${zona.nombre}: ${puntos.length} puntos de ruta → contorno de ${contorno.length} vértices`);
  }
  await writeFile(ARCHIVO, JSON.stringify({ type: 'FeatureCollection', features }, null, 1) + '\n');
  console.log(`Guardadas ${features.length} zonas aproximadas en ${ARCHIVO}`);
}
