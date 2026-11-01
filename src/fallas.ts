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

/** Deja una falla esperando /confirmar, junto a las que ya estuvieran esperando. */
export async function prepararFalla(db: BaseDeDatos, f: Pick<Falla, 'lugares' | 'texto' | 'fuente'>, ahora: number) {
  await db
    .prepare('INSERT INTO fallas (lugares, texto, fuente, creado, hasta, confirmada) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(JSON.stringify(f.lugares), f.texto, f.fuente ?? '', ahora, ahora)
    .run();
  // Las viejas no sirven más: no se guardan datos de más.
  await db.prepare('DELETE FROM fallas WHERE hasta < ?').bind(ahora - 30 * 24 * HORA).run();
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
