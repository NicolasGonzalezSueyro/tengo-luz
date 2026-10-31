import { readFile, writeFile } from 'node:fs/promises';

// Simplifica los contornos del mapa para que el archivo pese menos y la página cargue más rápido en el celular.
// Usa el algoritmo de Douglas-Peucker: saca los puntos que, si se quitan, mueven el contorno menos de unos metros
// (los repetidos, los que están en línea recta). A la vista queda igual. Se aplica al descargar los barrios
// (`npm run barrios`) y se puede correr sobre el archivo actual con `npm run simplificar`.

type Punto = [number, number]; // [longitud, latitud]
type Geometria = { type: string; coordinates: unknown };

export const TOLERANCIA_METROS = 4;

/** Distancia en metros de `p` al segmento a-b (proyección local: alcanza para una ciudad). */
function distanciaAlSegmento(p: Punto, a: Punto, b: Punto): number {
  const escala = Math.cos((a[1] * Math.PI) / 180) * 111_320; // metros por grado de longitud a esta latitud
  const [px, py, ax, ay, bx, by] = [p[0] * escala, p[1] * 110_540, a[0] * escala, a[1] * 110_540, b[0] * escala, b[1] * 110_540];
  const largo = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = largo === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / largo));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

/** Douglas-Peucker: conserva los extremos y, recursivamente, el punto más alejado si se aparta más que `metros`. */
export function simplificarLinea(puntos: Punto[], metros: number): Punto[] {
  if (puntos.length <= 2) return puntos;
  const [primero, ultimo] = [puntos[0], puntos[puntos.length - 1]];
  let lejano = 0;
  let distancia = 0;
  for (let i = 1; i < puntos.length - 1; i++) {
    const d = distanciaAlSegmento(puntos[i], primero, ultimo);
    if (d > distancia) [lejano, distancia] = [i, d];
  }
  if (distancia <= metros) return [primero, ultimo];
  return [...simplificarLinea(puntos.slice(0, lejano + 1), metros).slice(0, -1), ...simplificarLinea(puntos.slice(lejano), metros)];
}

/**
 * Un anillo cerrado (el primer punto se repite al final). Se parte en dos mitades para que Douglas-Peucker no
 * lo colapse (en un anillo, los extremos son el mismo punto). Si quedara con menos de 4 puntos, se deja como estaba.
 */
function simplificarAnillo(anillo: Punto[], metros: number): Punto[] {
  if (anillo.length <= 5) return anillo;
  const mitad = Math.floor(anillo.length / 2);
  const resultado = [...simplificarLinea(anillo.slice(0, mitad + 1), metros).slice(0, -1), ...simplificarLinea(anillo.slice(mitad), metros)];
  return resultado.length >= 4 ? resultado : anillo;
}

export function simplificarGeometria(geometria: Geometria, metros = TOLERANCIA_METROS): Geometria {
  const poligono = (anillos: Punto[][]) => anillos.map((a) => simplificarAnillo(a, metros));
  if (geometria.type === 'Polygon') return { ...geometria, coordinates: poligono(geometria.coordinates as Punto[][]) };
  if (geometria.type === 'MultiPolygon') return { ...geometria, coordinates: (geometria.coordinates as Punto[][][]).map(poligono) };
  return geometria; // los puntos quedan igual
}

if (import.meta.main) {
  for (const archivo of ['data/barrios.geojson', 'data/zonas.geojson']) {
    const texto = await readFile(archivo, 'utf8');
    const mapa = JSON.parse(texto) as { features: { geometry: Geometria }[] };
    for (const f of mapa.features) f.geometry = simplificarGeometria(f.geometry);
    const nuevo = archivo.endsWith('barrios.geojson') ? JSON.stringify(mapa) + '\n' : JSON.stringify(mapa, null, 1) + '\n';
    await writeFile(archivo, nuevo);
    console.log(`${archivo}: ${Math.round(texto.length / 1024)} KB → ${Math.round(nuevo.length / 1024)} KB`);
  }
}
