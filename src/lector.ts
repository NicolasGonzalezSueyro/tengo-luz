import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { barrioEnPunto, momentoEnCordoba } from '../web/estado.js';
import { alertar } from './alertar.ts';
import {
  centro, crearUbicador, esDescripcion, lugaresSeparados, normalizar, separarDeLocalidades, type Punto, type Ubicacion,
} from './barrios.ts';
import { buscarNotas, descargar, parsearNota } from './fuentes/eldoce.ts';
import { aplicarManuales, crearUbicadorDeLocalidades, tramosDelCorte, type Candidato, type Localidad, localidadesComoBarrios } from './localidades.ts';
import { crearBuscadorDeBarrios, type BarrioConocido } from './nombres.ts';
import { escribirLugares } from './lugares.ts';
import { sectorDelCorte, type Caja } from './sectores.ts';
import { CAPITAL, unir, type Mantenimiento } from './mantenimiento.ts';
import { aplicarContornos } from './contornos.ts';

const ARCHIVO = 'data/mantenimientos.json';
// Leemos las últimas notas por si alguna corrida anterior falló o la nota se actualizó.
const NOTAS_A_LEER = 3;

async function leerGuardados(): Promise<Mantenimiento[]> {
  try {
    // Los cortes guardados antes de ampliar a Gran Córdoba no tienen localidad: eran todos de capital.
    return (JSON.parse(await readFile(ARCHIVO, 'utf8')) as Mantenimiento[]).map((m) => ({ ...m, localidad: m.localidad ?? CAPITAL }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // primera vez: todavía no hay archivo
    throw error;
  }
}

async function leerJson<T>(archivo: string): Promise<T> {
  return JSON.parse(await readFile(archivo, 'utf8'));
}

/** La caja [sur, oeste, norte, este] que encierra a todas las geometrías, agrandada `margen` grados. */
function cajaDe(features: { geometry: { coordinates: unknown } }[], margen: number): Caja {
  const puntos = features.flatMap((f) => (f.geometry.coordinates as unknown[]).flat(3) as number[]);
  const lons = puntos.filter((_, i) => i % 2 === 0);
  const lats = puntos.filter((_, i) => i % 2 === 1);
  return [Math.min(...lats) - margen, Math.min(...lons) - margen, Math.max(...lats) + margen, Math.max(...lons) + margen];
}

// Lo que haya que revisar a mano: al final se manda por Telegram al admin (src/alertar.ts).
const alertas: { texto: string; detalle?: string }[] = [];

// Si no se puede leer el sitemap, el lector se corta (no hay nada que hacer) y GitHub Actions avisa de la falla.
const urls = (await buscarNotas()).slice(0, NOTAS_A_LEER);
if (urls.length === 0) {
  // El sitemap de noticias solo muestra los últimos ~2 días: sin notas, El Doce no publica hace 2 días o cambió el link.
  alertas.push({ texto: 'No encontré notas de cortes de El Doce en los últimos 2 días. ¿Dejaron de publicarlas o cambiaron el link?' });
}

const nuevos: Mantenimiento[] = [];
for (const url of urls) {
  // Una nota rara no frena a las demás: se avisa y se sigue.
  try {
    const { mantenimientos, noReconocidas } = parsearNota(await descargar(url), url);
    console.log(`${mantenimientos.filter((m) => m.localidad === CAPITAL).length} cortes en capital y ${mantenimientos.length} en total ← ${url}`);
    if (noReconocidas.length > 0) {
      alertas.push({ texto: `Hay renglones de cortes que no entendí:\n${noReconocidas.map((r) => `• ${r}`).join('\n')}`, detalle: url });
    }
    nuevos.push(...mantenimientos);
  } catch (error) {
    alertas.push({ texto: `No pude leer una nota de cortes de El Doce: ${(error as Error).message}`, detalle: url });
  }
}

// Ubicamos todos los cortes (también los viejos), así una mejora en los alias corrige el historial.
type Geometria = { type: string; coordinates: unknown };
const mapa = await leerJson<{ features: { properties: { nombre: string | null }; geometry: Geometria }[] }>('data/barrios.geojson');
const ZONAS = 'data/zonas.geojson';
const zonas = await leerJson<{ type: 'FeatureCollection'; features: Localidad[] }>(ZONAS);
const alias = await leerJson<Record<string, string | null>>('data/alias-barrios.json');
const ubicar = crearUbicador(
  mapa.features.flatMap((f) => f.properties.nombre ?? []),
  alias,
  zonas.features.map((f) => f.properties).filter((z) => z.tipo !== 'localidad'),
);

// Localidades de toda la provincia (src/localidades.ts). Lo que ya se buscó en OpenStreetMap queda en
// data/localidades-buscadas.json, y las localidades nuevas se agregan a data/zonas.geojson.
const BUSCADAS = 'data/localidades-buscadas.json';
const buscadas = await leerJson<Record<string, Candidato[]>>(BUSCADAS).catch(() => ({}) as Record<string, Candidato[]>);
const localidadesAntes = zonas.features.length;
// Los pueblos que OpenStreetMap no tiene, cargados a mano con sus coordenadas (ver aplicarManuales).
const MANUALES = 'data/localidades-manuales.json';
const manuales = await leerJson<Record<string, string>>(MANUALES).catch(() => ({}));
const { invalidas, cambiaron: cambiaronManuales } = aplicarManuales(zonas.features, buscadas, manuales);
if (invalidas.length > 0) {
  alertas.push({
    texto: `Hay localidades cargadas a mano con coordenadas que no entendí o que caen fuera de la provincia:\n${invalidas.map((n) => `• ${n}`).join('\n')}`,
    detalle: `Revisá ${MANUALES}: van como "-31.4167, -64.1833" (latitud, longitud), tal como las copia Google Maps.`,
  });
}
const ubicarLocalidades = crearUbicadorDeLocalidades(zonas.features, buscadas);
// Los barrios de las localidades del interior (npm run barrios-interior): con contorno de OSM o aproximado.
const interior = await leerJson<{ features: { properties: BarrioConocido & { tipo: string } }[] }>('data/barrios-interior.geojson')
  .catch(() => ({ features: [] }));
const aliasInterior = await leerJson<Record<string, string | null>>('data/alias-interior.json').catch(() => ({}));
const buscarEnLocalidad = crearBuscadorDeBarrios([...interior.features.map((f) => f.properties), ...localidadesComoBarrios(zonas.features)], aliasInterior);
// "Corte total en la localidad", "todos los barrios": se pinta el casco urbano entero.
const TODA_LA_LOCALIDAD = /\b(corte total|toda la localidad|todas? las localidades|todos los barrios|ambas localidades|en forma total en la localidad)\b/i;

const guardadosYNuevos = unir(await leerGuardados(), nuevos);
const ubicacionDe = new Map<string, Ubicacion>();
const noEncontradas = new Set<string>();
for (const m of guardadosYNuevos.filter((c) => c.localidad !== CAPITAL)) {
  const clave = `${m.localidad}|${m.zona}`;
  if (ubicacionDe.has(clave)) continue;
  try {
    // Cada tramo del texto con sus localidades: los barrios se buscan solo en ellas.
    const ubicacion: Required<Ubicacion> = { barrios: [], zonas: [], sinUbicar: [], parciales: [] };
    for (const tramo of tramosDelCorte(m.localidad, m.zona)) {
      const { localidades, noEncontradas: nuevasSinUbicar } = await ubicarLocalidades(tramo.nombres);
      nuevasSinUbicar.forEach((n) => noEncontradas.add(n));
      if (localidades.length === 0) continue;
      const { barrios, sinUbicar } = buscarEnLocalidad(localidades, tramo.texto);
      ubicacion.zonas.push(...localidades);
      ubicacion.barrios.push(...barrios);
      ubicacion.sinUbicar.push(...sinUbicar.map(normalizar));
      // Si nombra barrios o calles, no es toda la localidad: se pintan esos barrios (o el sector), no el pueblo.
      const entera = TODA_LA_LOCALIDAD.test(tramo.texto) || (barrios.length === 0 && sinUbicar.length === 0 && !esDescripcion(normalizar(tramo.texto)));
      if (!entera) ubicacion.parciales.push(...localidades);
    }
    ubicacionDe.set(clave, {
      barrios: [...new Set(ubicacion.barrios)],
      zonas: [...new Set(ubicacion.zonas)],
      sinUbicar: [...new Set(ubicacion.sinUbicar)],
      ...(ubicacion.parciales.length ? { parciales: [...new Set(ubicacion.parciales)] } : {}),
    });
  } catch (error) {
    // Sin conexión con OpenStreetMap: ese corte queda afuera esta vez y se vuelve a intentar en la próxima corrida.
    console.warn(`⚠️  No pude ubicar las localidades de "${clave.slice(0, 80)}…": ${(error as Error).message}`);
  }
}
if (noEncontradas.size > 0) {
  // Se avisa una sola vez: la búsqueda queda guardada y no se repite.
  alertas.push({
    texto: `No encontré en OpenStreetMap estas localidades de cortes:\n${[...noEncontradas].map((n) => `• ${n}`).join('\n')}`,
    detalle: `Si es un error de tipeo de la nota, no hace falta hacer nada. Si es un pueblo real, agregalo en ${MANUALES} con sus coordenadas de Google Maps, por ejemplo: "Mula Muerta": "-30.0123, -64.4567"`,
  });
}

/**
 * Capital se ubica por barrios (y rutas). Fuera de capital, por localidad y por los barrios de esa localidad:
 * nunca barrios de capital, así un "barrio Don Bosco" de Alta Gracia no pinta el de capital.
 */
const ubicarCorte = (m: Mantenimiento): Ubicacion =>
  m.localidad === CAPITAL ? ubicarEnCapital(m.zona) : ubicacionDe.get(`${m.localidad}|${m.zona}`) ?? { barrios: [], zonas: [], sinUbicar: [] };

// Capital: lo que no se encuentra a la primera se busca con la comparación tolerante ("Santa Isabel 2" es
// "Santa Isabel 2ª Sección"), entre los barrios de capital y los que se agregaron con contorno aproximado.
const buscarEnCapital = crearBuscadorDeBarrios([
  ...mapa.features.flatMap((f) => (f.properties.nombre ? [{ nombre: f.properties.nombre, base: f.properties.nombre, localidad: CAPITAL }] : [])),
  ...interior.features.map((f) => f.properties).filter((b) => b.localidad === CAPITAL),
]);
function ubicarEnCapital(zona: string): Ubicacion {
  const ubicacion = ubicar(zona);
  const barrios = new Set(ubicacion.barrios);
  const sinUbicar = ubicacion.sinUbicar.filter((pedazo) => {
    if (esDescripcion(pedazo)) return true;
    const [encontrado] = buscarEnCapital([CAPITAL], pedazo).barrios;
    if (encontrado) barrios.add(encontrado);
    return !encontrado;
  });
  return { ...ubicacion, barrios: [...barrios], sinUbicar };
}

const todos: (Mantenimiento & Ubicacion & { sector?: Punto[] })[] = guardadosYNuevos
  .map((m) => ({ ...m, ...ubicarCorte(m) }))
  // De fuera de capital, solo los cortes que se pudieron ubicar en alguna localidad.
  .filter((m) => m.localidad === CAPITAL || m.zonas.length > 0);

// Sectores exactos (src/sectores.ts) para los cortes descriptos por calles o lugares. Cada uno se busca en
// OpenStreetMap una sola vez y queda guardado en data/sectores.json (null = no se pudo armar: se marca la zona entera).
const SECTORES = 'data/sectores.json';
const sectoresGuardados = await leerJson<Record<string, Punto[] | null>>(SECTORES).catch(() => ({}) as Record<string, Punto[] | null>);
const sectores: Record<string, Punto[] | null> = {};
const porNombre = (features: { properties: { nombre: string | null }; geometry: Geometria }[], nombres: string[]) =>
  features.filter((f) => f.properties.nombre && nombres.includes(f.properties.nombre));

/** Dónde buscar el sector: la localidad (si es una sola), o los barrios del corte en capital si el texto nombra calles. */
function zonaDeBusqueda(m: Mantenimiento & Ubicacion) {
  // En el interior, el sector se arma solo si el anuncio describe calles (los barrios ya tienen su contorno).
  if (m.localidad !== CAPITAL) return m.zonas.length === 1 && esDescripcion(normalizar(m.zona)) ? porNombre(zonas.features, m.zonas) : [];
  return m.barrios.length > 0 && m.sinUbicar.some(esDescripcion) ? porNombre(mapa.features, m.barrios) : [];
}

// Overpass puede tardar ~30 s por sector: como mucho 8 nuevos por corrida, así el robot no pasa su límite de tiempo.
// Los que no entran se buscan en la corrida siguiente; mientras tanto el corte marca la zona entera.
const SECTORES_POR_CORRIDA = 8;
let sectoresNuevos = 0;
// Primero los cortes más nuevos (los que vienen), que son los que la gente mira.
for (const m of [...todos].sort((a, b) => b.fecha.localeCompare(a.fecha))) {
  const zona = zonaDeBusqueda(m);
  if (zona.length === 0) continue;
  const clave = `${m.localidad}|${m.zona}`;
  if (!(clave in sectores)) {
    if (clave in sectoresGuardados) {
      sectores[clave] = sectoresGuardados[clave];
    } else {
      if (sectoresNuevos === SECTORES_POR_CORRIDA) continue;
      sectoresNuevos++;
      try {
        // En capital las calles nombradas suelen ser el borde del barrio, así que sus esquinas caen justo en el límite:
        // se busca en la caja del barrio agrandada (~400 m). En las localidades sí se exige estar dentro del municipio,
        // porque un mismo corte puede nombrar barrios de pueblos vecinos.
        const enCapital = m.localidad === CAPITAL;
        sectores[clave] = await sectorDelCorte(
          m.zona,
          cajaDe(zona, enCapital ? 0.004 : 0),
          enCapital ? undefined : (p) => barrioEnPunto(zona, p) !== null,
          { conBarrios: !enCapital },
        );
        console.log(`🧭 Sector de "${m.zona.slice(0, 60)}…": ${sectores[clave] ? 'armado' : 'no se pudo, se marca la zona entera'}`);
        await new Promise((listo) => setTimeout(listo, 2000)); // sin apurar a Overpass, que es gratuito y compartido
      } catch (error) {
        // Sin conexión con OpenStreetMap: no se guarda nada y se vuelve a intentar en la próxima corrida.
        console.warn(`⚠️  No pude buscar el sector de "${m.zona.slice(0, 60)}…": ${(error as Error).message}`);
        continue;
      }
    }
  }
  const sector = sectores[clave];
  if (sector) m.sector = sector;
}

await mkdir('data', { recursive: true });
// Solo quedan los sectores de los cortes guardados: el archivo no crece para siempre.
await writeFile(SECTORES, JSON.stringify(sectores) + '\n');
const nuevoTexto = JSON.stringify(todos, null, 2) + '\n';
// Solo cuando cambian los cortes: así la página sabe que tiene que traerlos de nuevo y muestra desde cuándo están,
// y el robot no hace un commit (y Cloudflare una publicación) en cada corrida.
if ((await readFile(ARCHIVO, 'utf8').catch(() => '')) !== nuevoTexto) {
  await writeFile('data/actualizado.json', JSON.stringify({ cortes: new Date().toISOString() }) + '\n');
}
await writeFile(ARCHIVO, nuevoTexto);
await writeFile(BUSCADAS, JSON.stringify(buscadas, null, 1) + '\n');
if (zonas.features.length > localidadesAntes || cambiaronManuales) {
  await writeFile(ZONAS, JSON.stringify(aplicarContornos(zonas, 'zonas'), null, 1) + '\n');
  // Una localidad nueva que se llama como un barrio de capital: el barrio pasa a "X (Córdoba)".
  const nombresDeLocalidades = new Set(zonas.features.filter((z) => z.properties.tipo === 'localidad').map((z) => z.properties.nombre));
  if (separarDeLocalidades(mapa.features, nombresDeLocalidades) > 0) await writeFile('data/barrios.geojson', JSON.stringify(mapa) + '\n');
  escribirLugares(); // el bot y los reportes reconocen las localidades nuevas
  console.log(`🗺️  ${zonas.features.length - localidadesAntes} localidades nuevas en el mapa`);
}
console.log(`Guardados ${todos.length} cortes en ${ARCHIVO}`);

const sinUbicar = [...new Set(todos.flatMap((m) => m.sinUbicar))];
const enElMapa = todos.filter((m) => m.barrios.length > 0 || m.zonas.length > 0).length;
console.log(`📍 ${enElMapa} de ${todos.length} cortes se pueden marcar en el mapa (por barrio o zona aproximada).`);
if (sinUbicar.length) console.log(`❓ Sin ubicar (se pueden agregar a data/alias-barrios.json):\n   - ${sinUbicar.join('\n   - ')}`);

// Barrios de cortes que vienen y que no conocemos. No cuentan las descripciones de calles ni los alias en null
// (los que decidimos no ubicar a propósito).
const ignorados = new Set(Object.keys(alias).filter((nombre) => alias[nombre] === null).map(normalizar));
const queVienen = todos.filter((m) => m.fecha >= momentoEnCordoba().fecha);
// Solo capital: los barrios del interior que no se encuentran quedan en el informe del robot, sin alertas.
const desconocidos = [...new Set(queVienen.filter((m) => m.localidad === CAPITAL).flatMap((m) => m.sinUbicar))].filter((texto) => !esDescripcion(texto) && !ignorados.has(texto));
if (desconocidos.length > 0) {
  alertas.push({
    texto: `Hay barrios de cortes que vienen que no pude ubicar en el mapa:\n${desconocidos.map((d) => `• ${d}`).join('\n')}`,
    detalle: 'Se agregan en data/alias-barrios.json',
  });
}

// Barrios de un mismo corte muy separados: seguramente un nombre repetido se ubicó en el lugar equivocado.
const centros = new Map(
  [...mapa.features, ...zonas.features].flatMap((f): [string, Punto][] => (f.properties.nombre ? [[f.properties.nombre, centro(f.geometry)]] : [])),
);
// Solo en capital: un renglón de "Otras localidades" puede nombrar pueblos lejanos entre sí, y está bien.
for (const m of queVienen.filter((c) => c.localidad === CAPITAL)) {
  const separados = lugaresSeparados([...m.barrios, ...m.zonas], centros);
  if (separados) {
    alertas.push({
      texto: `Revisá un corte del ${m.fecha} (${m.desde} a ${m.hasta}): ${separados.a} y ${separados.b} quedan a ${Math.round(separados.km)} km. ¿Algún barrio se ubicó en el lugar equivocado?`,
      detalle: `${m.zona}\n${m.fuente}`,
    });
  }
}

for (const { texto, detalle } of alertas) await alertar(texto, detalle);
