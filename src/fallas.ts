// Fallas no programadas que EPEC confirma en sus redes ("sin suministro en barrio X por una falla").
// No se leen solas: el admin se las pasa al bot de Telegram (el link de la publicación de X, o el texto
// pegado), el bot reconoce los lugares y, con /confirmar, se muestran en el mapa unas horas.

import { alias as aliasInterior } from '../data/lugares.js';
import { esDescripcion, normalizar } from './barrios.ts';
import { CAPITAL } from './mantenimiento.ts';
import { crearBuscadorDeBarrios, type BarrioConocido } from './nombres.ts';
import type { BaseDeDatos } from './reportes.ts';

const HORA = 60 * 60 * 1000;
export const DURACION = 6 * HORA; // si nadie avisa que volvió la luz (/fin_falla), se saca sola
export const HISTORIAL = 90 * 24 * HORA; // lo que muestran las estadísticas de cortes repentinos: lo más viejo se borra

export type Falla = {
  id: number;
  lugares: string[];
  texto: string;
  fuente: string | null;
  creado: number;
  hasta: number;
  sector?: [number, number][]; // si EPEC describe calles: el área exacta, que arma el robot (src/sectores-fallas.ts)
};

// Un link a una publicación de X (o Twitter): https://x.com/usuario/status/123
export const LINK_X = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/i;
// Cuántos links se aceptan en un mismo mensaje: cada uno es un pedido a X, y Cloudflare gratis permite ~50 por vez.
export const MAXIMO_LINKS = 10;

/** Los links a publicaciones de X que tiene un mensaje, sin repetir. */
export const linksDeX = (texto: string) => [...new Set(texto.match(new RegExp(LINK_X.source, 'gi')) ?? [])];

/**
 * Los barrios y localidades del mapa que nombra un texto libre ("…sin suministro en B° Alto Alberdi y Alberdi…").
 * Primero los nombres más largos, así "Alto Alberdi" no cuenta también como "Alberdi".
 */
export function lugaresEnTexto(lugares: string[], texto: string): string[] {
  let resto = ` ${normalizar(texto)} `;
  const encontrados: string[] = [];
  const porLargo = lugares
    .map((l) => [normalizar(l), l] as const)
    .filter(([clave]) => clave.length >= 4) // nombres muy cortos coincidirían con cualquier cosa
    .sort((a, b) => b[0].length - a[0].length);
  for (const [clave, lugar] of porLargo) {
    if (!resto.includes(` ${clave} `)) continue;
    encontrados.push(lugar);
    resto = resto.replaceAll(` ${clave} `, ' | ');
  }
  return encontrados;
}

/**
 * Los lugares del mapa que nombra una publicación de EPEC, con el mapa ampliado. Si nombra localidades del interior,
 * se buscan sus barrios ("Villa María: barrio Centro" → "Centro (Villa María)"), y la localidad entera solo si no
 * nombra ninguno; si no nombra ninguna localidad, son barrios de capital, también con la comparación tolerante
 * ("Arguello Lourdes", "Santa Isabel 2"). Así un "Centro" del interior nunca pinta el de capital.
 */
export function reconocerLugares(lugares: string[], localidades: Set<string>, texto: string, alias: Record<string, string | null> = aliasInterior): string[] {
  const interior: BarrioConocido[] = [];
  const capital: BarrioConocido[] = [];
  for (const lugar of lugares) {
    const partes = lugar.match(/^(.+) \((.+)\)$/);
    if (partes && localidades.has(partes[2])) interior.push({ nombre: lugar, base: partes[1], localidad: partes[2] });
    else if (!localidades.has(lugar)) capital.push({ nombre: lugar, base: lugar, localidad: CAPITAL });
  }
  const buscar = crearBuscadorDeBarrios([...interior, ...capital], alias);
  const directos = lugaresEnTexto([...capital.map((c) => c.nombre), ...localidades], texto);
  const nombradas = directos.filter((l) => localidades.has(l));
  if (nombradas.length === 0) return [...new Set([...directos, ...buscar([CAPITAL], texto).barrios])];
  const resultado = new Set<string>();
  for (const localidad of nombradas) {
    // Sus barrios: los que aparecen tal cual en el texto, y los de las listas aunque estén escritos distinto.
    const propios = interior.filter((b) => b.localidad === localidad);
    const enTexto = lugaresEnTexto(propios.map((b) => b.base), texto).map((base) => propios.find((b) => b.base === base)!.nombre);
    const barrios = [...new Set([...enTexto, ...buscar([localidad], texto).barrios])];
    if (barrios.length > 0) barrios.forEach((b) => resultado.add(b));
    else resultado.add(localidad);
  }
  return [...resultado];
}

/**
 * El texto de una publicación de X, con el servicio oficial que usan los sitios para insertarlas (oEmbed):
 * es público, no pide clave y no hay que entrar a X. Devuelve null si no se pudo leer.
 */
export async function textoDePublicacion(link: string): Promise<{ texto: string; autor: string } | null> {
  const url = new URL('https://publish.x.com/oembed');
  url.search = new URLSearchParams({ url: link, omit_script: '1', dnt: 'true' }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  const { html, author_name } = (await res.json()) as { html?: string; author_name?: string };
  const parrafo = html?.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (!parrafo) return null;
  const texto = parrafo
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
  return { texto, autor: author_name ?? '' };
}

const comoFalla = (r: Record<string, unknown>): Falla => ({
  id: Number(r.id),
  lugares: JSON.parse(String(r.lugares)),
  texto: String(r.texto),
  fuente: r.fuente ? String(r.fuente) : null,
  creado: Number(r.creado),
  hasta: Number(r.hasta),
  ...(r.sector ? { sector: JSON.parse(String(r.sector)) } : {}),
});

/** Las fallas publicadas que describen calles y todavía no tienen su sector: las que tiene que armar el robot. */
export async function fallasSinSector(db: BaseDeDatos, ahora: number): Promise<Falla[]> {
  return (await fallasActivas(db, ahora)).filter((f) => !f.sector && nombraCalles(f.texto));
}

// Calles, rutas o un punto ("sector comprendido por calles…", "sobre ruta 5 a la altura del km 12"). No alcanza con
// la palabra "sector": casi todas las fallas terminan con "se trabaja en el sector", aunque solo nombren barrios.
const CALLES = /\b(calles?|comprendid[oa]s?|esquina|interseccion|avenida|av|bv|bulevar|boulevard|ruta|km|pasaje|altura)\b/;
/**
 * Si la falla describe calles o un lugar puntual: ahí se pinta el sector (el área de esas calles). Si solo nombra
 * barrios, se pintan los barrios enteros.
 */
export const nombraCalles = (texto: string) => CALLES.test(normalizar(texto));

/**
 * Guarda el sector de una falla (lo manda el robot). Se valida lo que llega: entre 3 y 2000 puntos, todos dentro de
 * la provincia de Córdoba. Devuelve false si la falla no existe o el sector no es válido.
 */
export async function guardarSector(db: BaseDeDatos, id: number, sector: unknown, ahora: number): Promise<boolean> {
  const valido = Array.isArray(sector) && sector.length >= 3 && sector.length <= 2000 && sector.every((p) =>
    Array.isArray(p) && p.length === 2 && p[0] >= -65.8 && p[0] <= -61.7 && p[1] >= -35.1 && p[1] <= -29.4);
  if (!valido || !(await fallasActivas(db, ahora)).some((f) => f.id === id)) return false;
  await db.prepare('UPDATE fallas SET sector = ? WHERE id = ?').bind(JSON.stringify(sector), id).run();
  return true;
}

/** Deja una falla esperando /confirmar, junto a las que ya estuvieran esperando. */
export async function prepararFalla(db: BaseDeDatos, f: Pick<Falla, 'lugares' | 'texto' | 'fuente'>, ahora: number) {
  await db
    .prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(JSON.stringify(f.lugares), f.texto, f.fuente ?? '', ahora, ahora)
    .run();
  // Las más viejas que el historial de las estadísticas no sirven más: no se guardan datos de más.
  await db.prepare('DELETE FROM fallas WHERE hasta < ?').bind(ahora - HISTORIAL).run();
}

/** Las fallas esperando /confirmar, en el orden en que llegaron (el bot las numera 1, 2, 3…). */
export async function fallasPendientes(db: BaseDeDatos): Promise<Falla[]> {
  return (await db.prepare('SELECT * FROM fallas WHERE confirmada = 0 ORDER BY id').bind().all()).results.map(comoFalla);
}

export async function corregirLugares(db: BaseDeDatos, id: number, lugares: string[]) {
  await db.prepare('UPDATE fallas SET lugares = ? WHERE id = ? AND confirmada = 0').bind(JSON.stringify(lugares), id).run();
}

/** Descarta una falla que esperaba confirmación, o todas si no se dice cuál. */
export async function cancelarFalla(db: BaseDeDatos, id?: number) {
  if (id === undefined) await db.prepare('DELETE FROM fallas WHERE confirmada = 0').bind().run();
  else await db.prepare('DELETE FROM fallas WHERE confirmada = 0 AND id = ?').bind(id).run();
}

/** Publica las fallas que esperaban y ya tienen lugares: desde ahora y por DURACION. Las demás siguen esperando. */
export async function confirmarFallas(db: BaseDeDatos, ahora: number): Promise<Falla[]> {
  const listas = (await fallasPendientes(db)).filter((f) => f.lugares.length > 0);
  for (const f of listas) {
    await db.prepare('UPDATE fallas SET confirmada = 1, creado = ?, hasta = ? WHERE id = ?').bind(ahora, ahora + DURACION, f.id).run();
  }
  return listas.map((f) => ({ ...f, creado: ahora, hasta: ahora + DURACION }));
}

/**
 * Las fallas como las recibe la página. El sector va solo si la falla nombra calles: las que solo nombran barrios se
 * pintan por barrio (algunas viejas tienen un sector armado por error, por el "se trabaja en el sector" del final).
 */
export async function fallasParaElMapa(db: BaseDeDatos, ahora: number) {
  return (await fallasActivas(db, ahora))
    .map(({ lugares, texto, fuente, creado, hasta, sector }) => ({ lugares, texto, fuente, creado, hasta, ...(sector && nombraCalles(texto) ? { sector } : {}) }));
}

/** Las fallas publicadas que todavía se muestran, la más nueva primero. */
export async function fallasActivas(db: BaseDeDatos, ahora: number): Promise<Falla[]> {
  const { results } = await db.prepare('SELECT * FROM fallas WHERE confirmada = 1 AND hasta > ? ORDER BY creado DESC').bind(ahora).all();
  return results.map(comoFalla);
}

// ---------------------------------------------------------------------------------------------
// Publicaciones que manda un extractor externo (POST /api/fallas)
// ---------------------------------------------------------------------------------------------

/** Lo que manda el extractor por cada publicación de EPEC. */
export type Publicacion = { id: string; url: string; texto: string; publicado?: string };
export type Resultado = {
  id: string;
  estado: 'publicada' | 'pendiente' | 'sin_lugares' | 'repetida' | 'restablecida' | 'ignorada';
  lugares: string[];
  quitados?: string[]; // en una "restablecida": los lugares que se sacaron de fallas publicadas
};

/**
 * Una falla se publica sola si se reconoció al menos un lugar y no mezcla barrios de capital con localidades del
 * interior: "Villa María: barrio Centro" encontraría también el Centro de capital. Las demás las revisa el admin.
 */
export const esConfiable = (encontrados: string[], localidades: Set<string>) =>
  encontrados.length > 0 && (encontrados.every((l) => localidades.has(l)) || encontrados.every((l) => !localidades.has(l)));

/** Publica una falla directamente (sin esperar /confirmar), desde ahora y por DURACION. */
async function publicarFalla(db: BaseDeDatos, f: Pick<Falla, 'lugares' | 'texto' | 'fuente'>, ahora: number): Promise<Falla> {
  await db
    .prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(JSON.stringify(f.lugares), f.texto, f.fuente ?? '', ahora, ahora + DURACION)
    .run();
  const fila = await db.prepare('SELECT * FROM fallas WHERE confirmada = 1 AND fuente = ? ORDER BY id DESC LIMIT 1').bind(f.fuente ?? '').first();
  return comoFalla(fila!);
}

// Cómo habla EPEC de un corte que no estaba programado, y de cuando vuelve la luz.
const HABLA_DE_FALLA = /\b(falla|averia|sin (suministro|servicio|energia|luz)|interrup|inconveniente|afectad|contingencia|imprevist|no programad|desperfecto|cable cortado|tormenta|restriccion del servicio)/;
const HABLA_DE_REGRESO = /\b(restablec|normalizad|normalizo|volvio (el servicio|la luz|la energia)|repuesto el servicio)/;

/** Qué es una publicación: una falla, el aviso de que volvió la luz, u otra cosa (cortes programados, campañas…). */
export function clasificar(texto: string): 'falla' | 'restablecida' | 'otra' {
  const t = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (HABLA_DE_REGRESO.test(t) && !/\bsin (suministro|servicio|energia|luz)\b/.test(t)) return 'restablecida';
  return HABLA_DE_FALLA.test(t) ? 'falla' : 'otra';
}

/** Valida lo que llega de afuera. Devuelve la publicación limpia o el motivo del rechazo. */
export function publicacionValida(valor: unknown): Publicacion | string {
  const p = valor as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return 'cada publicación tiene que ser un objeto';
  const id = typeof p.id === 'number' ? String(p.id) : p.id;
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return '"id" tiene que ser un texto de hasta 64 letras, números o guiones';
  if (typeof p.url !== 'string' || p.url.length > 300 || !/^https:\/\/[^\s]+$/.test(p.url)) return '"url" tiene que ser un link https';
  if (typeof p.texto !== 'string' || !p.texto.trim() || p.texto.length > 2000) return '"texto" tiene que tener entre 1 y 2000 caracteres';
  if (p.publicado !== undefined && (typeof p.publicado !== 'string' || Number.isNaN(Date.parse(p.publicado)))) return '"publicado" tiene que ser una fecha ISO 8601';
  return { id, url: p.url, texto: p.texto.trim(), ...(p.publicado ? { publicado: String(p.publicado) } : {}) };
}

/**
 * Procesa las publicaciones que manda el extractor. Las fallas confiables (ver esConfiable) se publican solas;
 * las raras quedan esperando /confirmar en el bot, igual que si el admin hubiera compartido el link.
 * Una publicación ya recibida (mismo link) no se repite. Devuelve el resultado de cada una y las fallas publicadas.
 */
export async function recibirPublicaciones(
  db: BaseDeDatos,
  lugares: string[],
  localidades: Set<string>,
  publicaciones: Publicacion[],
  ahora: number,
): Promise<{ resultados: Resultado[]; publicadas: Falla[] }> {
  const resultados: Resultado[] = [];
  const publicadas: Falla[] = [];
  for (const p of publicaciones) {
    const tipo = clasificar(p.texto);
    const encontrados = reconocerLugares(lugares, localidades, p.texto);
    if (tipo === 'otra') {
      resultados.push({ id: p.id, estado: 'ignorada', lugares: encontrados });
      continue;
    }
    // Una publicación ya recibida (falla o "volvió el servicio") no se procesa ni se avisa de nuevo.
    if (await db.prepare('SELECT 1 AS si FROM fallas WHERE fuente = ?').bind(p.url).first()) {
      resultados.push({ id: p.id, estado: 'repetida', lugares: encontrados });
      continue;
    }
    if (tipo === 'restablecida') {
      // Se anota solo para reconocerla si vuelve a llegar (confirmada = -1: nunca se muestra en el mapa).
      await db
        .prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, -1)')
        .bind(JSON.stringify(encontrados), p.texto, p.url, ahora, ahora)
        .run();
      // Lo que EPEC confirma que se normalizó sale del mapa (solo esos lugares; el resto de la falla sigue).
      const { quitados } = await restablecerLugares(db, encontrados, ahora);
      resultados.push({ id: p.id, estado: 'restablecida', lugares: encontrados, quitados });
      continue;
    }
    if (esConfiable(encontrados, localidades)) {
      publicadas.push(await publicarFalla(db, { texto: p.texto, fuente: p.url, lugares: encontrados }, ahora));
      resultados.push({ id: p.id, estado: 'publicada', lugares: encontrados });
      continue;
    }
    await prepararFalla(db, { texto: p.texto, fuente: p.url, lugares: encontrados }, ahora);
    resultados.push({ id: p.id, estado: encontrados.length > 0 ? 'pendiente' : 'sin_lugares', lugares: encontrados });
  }
  return { resultados, publicadas };
}

/**
 * EPEC confirmó que volvió el servicio en estos lugares: se sacan de las fallas publicadas, y la falla que se queda
 * sin lugares sale del mapa. Devuelve los lugares que se sacaron y los números de las fallas que terminaron.
 */
export async function restablecerLugares(db: BaseDeDatos, lugares: string[], ahora: number): Promise<{ quitados: string[]; terminadas: number[] }> {
  const quitados = new Set<string>();
  const terminadas: number[] = [];
  for (const falla of await fallasActivas(db, ahora)) {
    const quedan = falla.lugares.filter((l) => !lugares.includes(l));
    if (quedan.length === falla.lugares.length) continue;
    falla.lugares.filter((l) => lugares.includes(l)).forEach((l) => quitados.add(l));
    if (quedan.length === 0) {
      // Termina: se guardan sus lugares, para el historial y las estadísticas.
      await db.prepare('UPDATE fallas SET hasta = ? WHERE id = ?').bind(ahora, falla.id).run();
      terminadas.push(falla.id);
    } else {
      await db.prepare('UPDATE fallas SET lugares = ? WHERE id = ?').bind(JSON.stringify(quedan), falla.id).run();
    }
  }
  return { quitados: [...quitados], terminadas };
}

/** Suma lugares a una falla publicada (los que el texto nombraba y no se reconocieron). Devuelve la falla actualizada. */
export async function agregarLugares(db: BaseDeDatos, id: number, nuevos: string[], ahora: number): Promise<Falla | null> {
  const falla = (await fallasActivas(db, ahora)).find((f) => f.id === id);
  if (!falla) return null;
  const lugares = [...new Set([...falla.lugares, ...nuevos])];
  await db.prepare('UPDATE fallas SET lugares = ? WHERE id = ?').bind(JSON.stringify(lugares), id).run();
  return { ...falla, lugares };
}

/** Las fallas publicadas desde una fecha (para las estadísticas de cortes repentinos), con sus lugares y duración. */
export async function historialDeFallas(db: BaseDeDatos, desde: number) {
  const { results } = await db.prepare('SELECT * FROM fallas WHERE confirmada = 1 AND creado > ? ORDER BY creado').bind(desde).all();
  return results.map(comoFalla).filter((f) => f.lugares.length > 0).map(({ lugares, creado, hasta }) => ({ lugares, creado, hasta }));
}

/** "Volvió la luz": saca del mapa una falla (por su número) o todas. Devuelve cuántas sacó. */
export async function terminarFallas(db: BaseDeDatos, ahora: number, id?: number): Promise<number> {
  const activas = (await fallasActivas(db, ahora)).filter((f) => id === undefined || f.id === id);
  for (const f of activas) await db.prepare('UPDATE fallas SET hasta = ? WHERE id = ?').bind(ahora, f.id).run();
  return activas.length;
}
