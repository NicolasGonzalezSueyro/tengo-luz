// Compara nuestro mapa con Wikimapia (npm run comparar-wikimapia). Solo para revisar: Wikimapia permite usar sus
// datos con fines no comerciales, así que nada de lo que baja se guarda en data/ ni se publica. Sirve para:
// 1. Encontrar barrios nuestros cuyo contorno no coincide con el de Wikimapia (para corregirlos con manzanas y
//    parcelas oficiales).
// 2. Ubicar lugares que nombra EPEC y faltan en el mapa (data/lugares-faltantes.json).
// Necesita WIKIMAPIA_KEY en .env (node --env-file=.env). La clave gratis tiene un cupo diario (~100 pedidos): pide
// rectángulos grandes (Wikimapia devuelve primero los objetos más grandes, y los barrios están entre ellos), guarda
// todo en .cache/wikimapia/ y, si se acaba el cupo, compara con lo que ya bajó. Al otro día sigue donde quedó.
// Escribe .cache/wikimapia/informe.json.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { CAPITAL } from './mantenimiento.ts';
import { claveDeBarrio } from './nombres.ts';

const CLAVE = process.env.WIKIMAPIA_KEY;
const CACHE = '.cache/wikimapia';
const PASO = 0.05; // cuadrantes de capital de ~5 km
class SinCupo extends Error {}
const pausa = (ms: number) => new Promise((listo) => setTimeout(listo, ms));
type Area = Feature<Polygon | MultiPolygon>;
type Objeto = { id: string; nombre: string; area: Area; ha: number };

/** "Las Terrazas - Valle Escondido", "Barrio Los Aromas", "Country La Reserva" → el nombre que usamos nosotros. */
export function nombreWikimapia(nombre: string): string {
  return nombre
    .replace(/\s*[-–(].*$/, '') // "- Valle Escondido", "(Valle Escondido)"
    .replace(/^(barrio cerrado|barrio privado|barrio|b[°º]|country|club de campo|urbanizaci[oó]n|complejo|loteo|villa privada)\s+/i, '')
    .trim();
}

// Lo que no es un barrio: escuelas, plazas, comercios, edificios…
const NO_ES_BARRIO = /\b(colegio|escuela|instituto|ipem|jard[ií]n de infantes|universidad|facultad|club|plaza|plazoleta|parque|playa de estacionamiento|estacionamiento|panader[ií]a|hospital|cl[ií]nica|sanatorio|dispensario|iglesia|capilla|parroquia|supermercado|hipermercado|shopping|estaci[oó]n|cementerio|cancha|estadio|f[aá]brica|planta|dep[oó]sito|regimiento|terminal|aeropuerto|edificio|torre|condominio|hotel|caba[ñn]as|camping|r[ií]o|arroyo|canal|lago|dique|ruta|avenida|calle|autopista|circunvalaci[oó]n|cerro|reserva natural|campo|estancia|chacra|granja|vivero|cooperativa|municipalidad|comisar[ií]a|polic[ií]a|bomberos|cuartel)\b/i;

type Pagina = { objetos: { id: string; name: string; polygon?: { x: number; y: number }[] }[]; total: number };
let pedidos = 0;

async function bajarCaja(caja: number[], pagina: number): Promise<Pagina> {
  const archivo = `${CACHE}/caja_${caja.map((n) => n.toFixed(3)).join('_')}_${pagina}.json`;
  const guardado = await readFile(archivo, 'utf8').catch(() => null);
  if (guardado) return JSON.parse(guardado);
  const url = `http://api.wikimapia.org/?key=${CLAVE}&function=box&format=json&language=es&count=100&page=${pagina}`
    + `&bbox=${caja.map((n) => n.toFixed(5)).join(',')}`;
  for (let intento = 1; ; intento++) {
    await pausa(4000); // el límite es 100 pedidos cada 5 minutos: así quedan 75, con margen
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    const datos = res?.ok ? ((await res.json().catch(() => null)) as { folder?: never[]; found?: string; debug?: { code?: number; message?: string } } | null) : null;
    // Se acabó el cupo del día (o la clave quedó bloqueada un rato): se compara con lo que ya hay.
    if (datos?.debug?.code === 1004 || datos?.debug?.code === 1000) throw new SinCupo(datos.debug.message ?? 'sin cupo');
    if (datos && Array.isArray(datos.folder)) {
      pedidos++;
      const resultado = { objetos: datos.folder, total: Number(datos.found ?? 0) };
      await writeFile(archivo, JSON.stringify(resultado));
      return resultado;
    }
    if (intento === 4) throw new Error(`Wikimapia no respondió para ${archivo}: ${datos?.debug?.message ?? res?.status ?? 'sin conexión'}`);
    console.warn(`  Wikimapia: ${datos?.debug?.message ?? res?.status ?? 'sin conexión'}; reintento en un minuto…`);
    await pausa(60_000);
  }
}

/** Suma los objetos con contorno de una página. Devuelve la superficie del más chico (en hectáreas). */
function sumar(lista: Pagina['objetos'], objetos: Map<string, Objeto>): number {
  let masChico = Infinity;
  for (const o of lista) {
    if (!o.polygon || o.polygon.length < 3) continue;
    const anillo = o.polygon.map((p) => [p.x, p.y]);
    anillo.push(anillo[0]);
    let area: Area;
    try {
      area = turf.polygon([anillo]);
    } catch {
      continue;
    }
    const ha = turf.area(area) / 10_000;
    masChico = Math.min(masChico, ha);
    if (!objetos.has(o.id)) objetos.set(o.id, { id: o.id, nombre: o.name, area, ha });
  }
  return masChico;
}

/** Los objetos de un rectángulo, del más grande al más chico, hasta los de menos de 0,5 ha o `paginas` páginas. */
async function bajarCaja2(caja: number[], objetos: Map<string, Objeto>, paginas: number) {
  for (let pagina = 1; pagina <= paginas; pagina++) {
    const { objetos: lista, total } = await bajarCaja(caja, pagina);
    const masChico = sumar(lista, objetos);
    // Vienen de mayor a menor: cuando ya son casas sueltas, no hace falta seguir.
    if (lista.length < 100 || pagina * 100 >= total || masChico < 0.5) break;
  }
}

/** Qué tanto coinciden dos áreas: la superficie en común sobre la de la unión (1 = iguales, 0 = nada que ver). */
function coincidencia(a: Area, b: Area): number {
  try {
    const comun = turf.intersect(turf.featureCollection([a, b]));
    if (!comun) return 0;
    const union = turf.union(turf.featureCollection([a, b]));
    return union ? turf.area(comun) / turf.area(union) : 0;
  } catch {
    return 0;
  }
}

if (import.meta.main) {
  if (!CLAVE) throw new Error('Falta WIKIMAPIA_KEY en .env (correr con node --env-file=.env)');
  await mkdir(CACHE, { recursive: true });
  type Nuestro = Area & { properties: { nombre: string; base?: string; localidad?: string; tipo: string; fuente?: string } };
  const barrios = JSON.parse(await readFile('data/barrios.geojson', 'utf8')) as { features: Nuestro[] };
  const interior = JSON.parse(await readFile('data/barrios-interior.geojson', 'utf8')) as { features: Nuestro[] };
  const zonas = JSON.parse(await readFile('data/zonas.geojson', 'utf8')) as { features: Nuestro[] };
  const faltantes = JSON.parse(await readFile('data/lugares-faltantes.json', 'utf8')) as { nombre: string; localidad: string; veces: number }[];

  // Qué bajar: capital entera y el casco de cada localidad del mapa.
  const capital = [-64.32, -31.55, -64.05, -31.30];
  const localidades = zonas.features.filter((z) => z.properties.tipo === 'localidad' && (z.geometry.type as string) !== 'Point');
  const objetos = new Map<string, Objeto>();
  // Lo que ya se bajó otros días (también con otros tamaños de rectángulo) se aprovecha.
  for (const archivo of (await readdir(CACHE)).filter((a) => /_\d+\.json$/.test(a))) {
    sumar((JSON.parse(await readFile(`${CACHE}/${archivo}`, 'utf8')) as Pagina).objetos ?? [], objetos);
  }
  // Primero los pueblos con más barrios y lugares que nombra EPEC; capital, por cuadrantes de ~5 km.
  const peso = (nombre: string) => interior.features.filter((f) => f.properties.localidad === nombre).length
    + 3 * faltantes.filter((f) => f.localidad === nombre).length;
  const cajasCapital: number[][] = [];
  for (let x = capital[0]; x < capital[2]; x += PASO) for (let y = capital[1]; y < capital[3]; y += PASO) cajasCapital.push([x, y, x + PASO, y + PASO]);
  const tareas = [
    ...cajasCapital.map((caja, i) => ({ nombre: `capital ${i + 1}/${cajasCapital.length}`, caja, paginas: 3 })),
    ...localidades.sort((a, b) => peso(b.properties.nombre) - peso(a.properties.nombre))
      .map((l) => ({ nombre: l.properties.nombre, caja: turf.bbox(l), paginas: peso(l.properties.nombre) > 20 ? 3 : 1 })),
  ];
  let completas = 0;
  try {
    for (const t of tareas) {
      await bajarCaja2(t.caja, objetos, t.paginas);
      completas++;
      if (completas % 10 === 0) console.log(`  ${completas}/${tareas.length} zonas (${pedidos} pedidos hoy)`);
    }
  } catch (error) {
    if (!(error instanceof SinCupo)) throw error;
    console.log(`⏸️  Wikimapia: ${error.message}. Bajadas ${completas} de ${tareas.length} zonas; el resto, mañana (npm run comparar-wikimapia).`);
  }
  const barriosWm = [...objetos.values()].filter((o) => o.ha >= 0.3 && o.ha <= 600 && !NO_ES_BARRIO.test(o.nombre));
  console.log(`${objetos.size} objetos de Wikimapia, ${barriosWm.length} que pueden ser barrios.`);
  // Para el paso siguiente (src/revisar-contornos.ts): solo en .cache, nunca en data/.
  await writeFile(`${CACHE}/objetos.json`, JSON.stringify(barriosWm.map((o) => ({ id: o.id, nombre: o.nombre, ha: o.ha, geometria: o.area.geometry }))));

  // Los nuestros, con su localidad: capital (municipales, divisiones) e interior.
  const nuestros = [
    ...barrios.features.filter((f) => f.properties.nombre && (f.geometry.type as string) !== 'Point').map((f) => ({ ...f, properties: { ...f.properties, base: f.properties.nombre, localidad: CAPITAL } })),
    ...interior.features,
  ] as Nuestro[];
  const enLocalidad = (o: Objeto, localidad: string) => {
    const zona = localidad === CAPITAL ? turf.bboxPolygon(capital as [number, number, number, number]) : localidades.find((l) => l.properties.nombre === localidad);
    return Boolean(zona && turf.booleanPointInPolygon(turf.centroid(o.area), turf.buffer(zona, 1, { units: 'kilometers' })!));
  };
  const buscar = (base: string, localidad: string, cerca?: Area) => {
    const clave = claveDeBarrio(base);
    const candidatos = barriosWm.filter((o) => claveDeBarrio(nombreWikimapia(o.nombre)) === clave && enLocalidad(o, localidad));
    if (!cerca) return candidatos[0];
    return candidatos.sort((a, b) => turf.distance(turf.centroid(a.area), turf.centroid(cerca)) - turf.distance(turf.centroid(b.area), turf.centroid(cerca)))[0];
  };

  // 1. Comparación de los que ya tenemos.
  const comparados = nuestros.flatMap((f) => {
    const base = f.properties.base ?? f.properties.nombre;
    const localidad = f.properties.localidad ?? CAPITAL;
    const wm = buscar(base, localidad, f);
    if (!wm || turf.distance(turf.centroid(wm.area), turf.centroid(f)) > 3) return [];
    return [{
      nombre: f.properties.nombre, localidad, tipo: f.properties.tipo, fuente: f.properties.fuente ?? 'municipalidad',
      coincidencia: Math.round(coincidencia(f, wm.area) * 100) / 100, wikimapia: { id: wm.id, nombre: wm.nombre, ha: Math.round(wm.ha * 10) / 10 },
      nuestraHa: Math.round((turf.area(f) / 10_000) * 10) / 10,
    }];
  });
  // 2. Los que faltan y Wikimapia tiene.
  const encontrados = faltantes.flatMap((f) => {
    const wm = buscar(f.nombre, f.localidad);
    return wm ? [{ ...f, wikimapia: { id: wm.id, nombre: wm.nombre, ha: Math.round(wm.ha * 10) / 10 } }] : [];
  });
  const malos = comparados.filter((c) => c.coincidencia < 0.6);
  await writeFile(`${CACHE}/informe.json`, JSON.stringify({ comparados, encontrados }, null, 1));
  console.log(`Comparados: ${comparados.length} · coinciden bien (≥60 %): ${comparados.length - malos.length} · a revisar: ${malos.length}`);
  console.log(`Faltantes que Wikimapia tiene: ${encontrados.length} de ${faltantes.length}`);
}
