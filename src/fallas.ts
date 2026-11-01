// Fallas no programadas que EPEC confirma en sus redes ("sin suministro en barrio X por una falla").
// No se leen solas: el admin se las pasa al bot de Telegram (el link de la publicación de X, o el texto
// pegado), el bot reconoce los lugares y, con /confirmar, se muestran en el mapa unas horas.

import { normalizar } from './barrios.ts';
import type { BaseDeDatos } from './reportes.ts';

const HORA = 60 * 60 * 1000;
export const DURACION = 6 * HORA; // si nadie avisa que volvió la luz (/fin_falla), se saca sola

export type Falla = { id: number; lugares: string[]; texto: string; fuente: string | null; creado: number; hasta: number };

// Un link a una publicación de X (o Twitter): https://x.com/usuario/status/123
export const LINK_X = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/i;

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
});

/** Deja una falla esperando /confirmar (reemplaza a la que hubiera esperando). */
export async function prepararFalla(db: BaseDeDatos, f: Pick<Falla, 'lugares' | 'texto' | 'fuente'>, ahora: number) {
  await cancelarFalla(db);
  await db
    .prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(JSON.stringify(f.lugares), f.texto, f.fuente ?? '', ahora, ahora)
    .run();
  // Las viejas no sirven más: no se guardan datos de más.
  await db.prepare('DELETE FROM fallas WHERE hasta < ?').bind(ahora - 30 * 24 * HORA).run();
}

export async function fallaPendiente(db: BaseDeDatos): Promise<Falla | null> {
  const fila = await db.prepare('SELECT * FROM fallas WHERE confirmada = 0 ORDER BY id DESC LIMIT 1').bind().first();
  return fila ? comoFalla(fila) : null;
}

export async function corregirLugares(db: BaseDeDatos, id: number, lugares: string[]) {
  await db.prepare('UPDATE fallas SET lugares = ? WHERE id = ?').bind(JSON.stringify(lugares), id).run();
}

export async function cancelarFalla(db: BaseDeDatos) {
  await db.prepare('DELETE FROM fallas WHERE confirmada = 0').bind().run();
}

/** Publica la falla que estaba esperando: desde ahora y por DURACION. */
export async function confirmarFalla(db: BaseDeDatos, ahora: number): Promise<Falla | null> {
  const falla = await fallaPendiente(db);
  if (!falla) return null;
  await db.prepare('UPDATE fallas SET confirmada = 1, creado = ?, hasta = ? WHERE id = ?').bind(ahora, ahora + DURACION, falla.id).run();
  return { ...falla, creado: ahora, hasta: ahora + DURACION };
}

/** Las fallas publicadas que todavía se muestran, la más nueva primero. */
export async function fallasActivas(db: BaseDeDatos, ahora: number): Promise<Falla[]> {
  const { results } = await db.prepare('SELECT * FROM fallas WHERE confirmada = 1 AND hasta > ? ORDER BY creado DESC').bind(ahora).all();
  return results.map(comoFalla);
}

/** "Volvió la luz": saca del mapa todas las fallas publicadas. Devuelve cuántas eran. */
export async function terminarFallas(db: BaseDeDatos, ahora: number): Promise<number> {
  const activas = await fallasActivas(db, ahora);
  await db.prepare('UPDATE fallas SET hasta = ? WHERE confirmada = 1 AND hasta > ?').bind(ahora, ahora).run();
  return activas.length;
}
