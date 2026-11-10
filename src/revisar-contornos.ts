// Rearma los contornos que no coinciden con Wikimapia y agrega los lugares que faltaban (npm run revisar-contornos).
// Va después de `npm run comparar-wikimapia`, que deja en .cache/wikimapia/ el informe y los contornos de referencia.
//
// El contorno de Wikimapia no se copia (sus datos son para uso no comercial): solo marca DÓNDE está el barrio. El
// contorno nuevo se arma con las manzanas oficiales de la Provincia (Mapas Córdoba, IDECOR) que caen adentro; si
// el lugar es un complejo sin manzanas, con las parcelas. Las calles entre manzanas quedan adentro y los huecos
// (plazas) se rellenan. Si las piezas oficiales no alcanzan a cubrir el lugar, no se toca: queda para el editor.
//
// Escribe data/contornos-revisados.geojson, que los scripts aplican como los manuales (src/contornos.ts).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { ARCHIVO_REVISADOS, type ContornoManual } from './contornos.ts';
import { CAPITAL } from './mantenimiento.ts';
import { claveDeBarrio } from './nombres.ts';
import { claveDeLugar } from './barrios-interior.ts';

type Area = Feature<Polygon | MultiPolygon>;
const CACHE = '.cache/wikimapia';
const IDECOR = 'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs';
const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };
const pausa = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

/** Manzanas o parcelas oficiales de un rectángulo (con caché en disco). */
async function piezas(capa: 'manzana' | 'parcelas', id: string, [o, s, e, n]: number[]): Promise<Area[]> {
  const archivo = `${CACHE}/idecor/${capa}-${id}.json`;
  const guardado = await readFile(archivo, 'utf8').catch(() => null);
  if (guardado) return JSON.parse(guardado);
  const url = `${IDECOR}?service=WFS&version=1.0.0&request=GetFeature&typeName=idecor:${capa}&outputFormat=application/json`
    + `&srsName=EPSG:4326&bbox=${o},${s},${e},${n},EPSG:4326`;
  await pausa(300);
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(120_000) }).catch(() => null);
  if (!res?.ok) return [];
  const lista = ((await res.json()) as { features: Area[] }).features.filter((f) => f.geometry).map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry }) as Area);
  await writeFile(archivo, JSON.stringify(lista));
  return lista;
}

const unir = (areas: Area[]): Area | null => {
  let total: Area | null = null;
  for (const a of areas) {
    try {
      total = total ? (turf.union(turf.featureCollection([total, a])) as Area | null) : a;
    } catch {
      // geometría rota: se saltea
    }
  }
  return total;
};

/**
 * El contorno armado con las piezas oficiales que caen dentro de la referencia, o null si no la cubren bien
 * (menos de la mitad). Exportado para los tests.
 */
export function armarConPiezas(referencia: Area, lista: Area[]): Area | null {
  // Una pieza cuenta si al menos la mitad cae adentro: una manzana grande que apenas roza el lugar no lo agranda.
  const mitadAdentro = (p: Area) => {
    try {
      const comun = turf.intersect(turf.featureCollection([p, referencia]));
      return Boolean(comun) && turf.area(comun!) >= 0.5 * turf.area(p);
    } catch {
      return turf.booleanPointInPolygon(turf.pointOnFeature(p), referencia);
    }
  };
  const adentro = lista.filter(mitadAdentro);
  if (adentro.length === 0) return null;
  // Se agranda 9 m y se achica 9 m: las calles entre manzanas quedan adentro y el borde sigue la línea de las cuadras.
  const juntas = unir(adentro.map((p) => turf.buffer(p, 9, { units: 'meters' }) as Area));
  if (!juntas) return null;
  const area = turf.simplify(turf.buffer(juntas, -9, { units: 'meters' }) as Area, { tolerance: 0.00002 });
  // Sin huecos: la plaza del medio es parte del barrio.
  const g = area.geometry;
  area.geometry = (g.type === 'Polygon' ? { type: 'Polygon', coordinates: [g.coordinates[0]] } : { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => [p[0]]) }) as never;
  return turf.area(area) >= 0.5 * turf.area(referencia) ? area : null;
}

const redondear = (g: Polygon | MultiPolygon) =>
  JSON.parse(JSON.stringify(g, (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))) as Polygon | MultiPolygon;

if (import.meta.main) {
  await mkdir(`${CACHE}/idecor`, { recursive: true });
  type Comparado = { nombre: string; localidad: string; tipo: string; fuente: string; coincidencia: number; wikimapia: { id: string } };
  type Encontrado = { nombre: string; localidad: string; wikimapia: { id: string } };
  const { comparados, encontrados } = JSON.parse(await readFile(`${CACHE}/informe.json`, 'utf8')) as { comparados: Comparado[]; encontrados: Encontrado[] };
  const crudos = JSON.parse(await readFile(`${CACHE}/objetos.json`, 'utf8')) as { id: string; nombre: string; ha: number; geometria: Polygon }[];
  const objetos = new Map(crudos.map((o) => [o.id, { type: 'Feature', properties: {}, geometry: o.geometria } as Area]));

  // Los aproximados que la comparación no encontró por nombre exacto: se busca una referencia de nombre parecido
  // ("7 Soles Universitario" y "Country Siete Soles") a menos de 1 km. Si la referencia es casi igual a un barrio
  // oficial de capital, no sirve: es el barrio entero, no la parte que se busca.
  const yaComparados = new Set(comparados.map((c) => `${c.localidad}|${claveDeBarrio(c.nombre)}`));
  const interiorActual = JSON.parse(await readFile('data/barrios-interior.geojson', 'utf8')) as { features: (Area & { properties: { nombre: string; base?: string; localidad: string; tipo: string } })[] };
  const oficialesCapital = (JSON.parse(await readFile('data/barrios.geojson', 'utf8')) as { features: Area[] }).features.filter((f) => f.geometry?.type !== ('Point' as string));
  const contiene = (a: string, b: string) => ` ${a} `.includes(` ${b} `);
  const conClave = crudos.filter((o) => o.ha >= 0.5 && o.ha < 300).map((o) => ({ ...o, clave: claveDeLugar(o.nombre.replace(/\s+-\s+.*$/, '')), area: objetos.get(o.id)! }));
  const esBarrioOficial = (a: Area) => oficialesCapital.some((b) => {
    try {
      const comun = turf.intersect(turf.featureCollection([a, b]));
      return Boolean(comun) && turf.area(comun!) > 0.7 * Math.max(turf.area(a), turf.area(b));
    } catch {
      return false;
    }
  });
  const parecidos: { nombre: string; localidad: string; tipo: string; fuente: string; coincidencia: number; wikimapia: { id: string } }[] = [];
  for (const d of interiorActual.features.filter((f) => f.properties.tipo === 'aproximado')) {
    if (yaComparados.has(`${d.properties.localidad}|${claveDeBarrio(d.properties.nombre)}`)) continue;
    const clave = claveDeLugar(d.properties.base ?? d.properties.nombre);
    if (clave.length < 5) continue;
    const centro = turf.centroid(d).geometry.coordinates;
    const ref = conClave.filter((o) => (o.clave === clave || contiene(o.clave, clave) || contiene(clave, o.clave))
      && turf.distance(centro, turf.centroid(o.area).geometry.coordinates) < 1)
      .sort((a, b) => turf.distance(centro, turf.centroid(a.area).geometry.coordinates) - turf.distance(centro, turf.centroid(b.area).geometry.coordinates))[0];
    if (ref && !esBarrioOficial(ref.area)) {
      parecidos.push({ nombre: d.properties.nombre, localidad: d.properties.localidad, tipo: 'aproximado', fuente: 'parecido', coincidencia: 0, wikimapia: { id: ref.id } });
    }
  }
  console.log(`   ${parecidos.length} aproximados con una referencia de nombre parecido`);

  // Qué rearmar: los aproximados y los de OSM que no coinciden (los oficiales de la Municipalidad y de los
  // municipios no se tocan: si difieren, el oficial manda), y los que faltaban.
  const aRevisar = [
    ...comparados.filter((c) => c.coincidencia < 0.6 && (c.tipo === 'aproximado' || c.fuente === 'osm')),
    ...parecidos,
    ...encontrados.map((e) => ({ ...e, nombre: e.localidad === CAPITAL ? e.nombre : `${e.nombre} (${e.localidad})` })),
  ];
  const vistos = new Set<string>();
  const revisados: ContornoManual[] = [];
  const sinPiezas: string[] = [];
  for (const [n, r] of aRevisar.entries()) {
    const clave = `${r.localidad}|${claveDeBarrio(r.nombre)}`;
    const referencia = objetos.get(r.wikimapia.id);
    if (vistos.has(clave) || !referencia) continue;
    vistos.add(clave);
    const caja = turf.bbox(turf.buffer(referencia, 0.03, { units: 'kilometers' })!);
    const area = armarConPiezas(referencia, await piezas('manzana', r.wikimapia.id, caja))
      ?? armarConPiezas(referencia, await piezas('parcelas', r.wikimapia.id, caja));
    if (!area) {
      sinPiezas.push(`${r.nombre} · ${r.localidad}`);
      continue;
    }
    revisados.push({ type: 'Feature', properties: { nombre: r.nombre, destino: 'interior', localidad: r.localidad, original: null }, geometry: redondear(area.geometry) });
    if ((n + 1) % 25 === 0) console.log(`  ${n + 1}/${aRevisar.length}`);
  }
  // Los de corridas anteriores se mantienen (la comparación de hoy ya los ve bien y no los vuelve a elegir).
  const anteriores = (JSON.parse(await readFile(ARCHIVO_REVISADOS, 'utf8').catch(() => '{"features":[]}')) as { features: ContornoManual[] }).features;
  const nuevos = new Set(revisados.map((r) => `${r.properties.localidad}|${r.properties.nombre}`));
  const todos = [...anteriores.filter((a) => !nuevos.has(`${a.properties.localidad}|${a.properties.nombre}`)), ...revisados];
  await writeFile(ARCHIVO_REVISADOS, JSON.stringify({ type: 'FeatureCollection', features: todos }) + '\n');
  await writeFile(`${CACHE}/sin-piezas.txt`, sinPiezas.join('\n') + '\n');
  console.log(`📐 ${ARCHIVO_REVISADOS}: ${revisados.length} contornos rearmados con manzanas o parcelas oficiales.`);
  console.log(`   ${sinPiezas.length} sin piezas oficiales que alcancen (quedan para el editor): ${CACHE}/sin-piezas.txt`);
}
