// Reconocer los barrios del interior que nombra EPEC, aunque los escriba distinto que el mapa ("Covicco" y
// "Covico", "Minetti III" y "Minetti", "Terrazas de la Estanzuela" y "Terrazas de Estanzuela"). Siempre dentro de
// las localidades del corte: un "Centro" de Villa María nunca es el de capital. Sin Turf ni nada pesado, así lo
// usan también las funciones de Cloudflare.

import { esDescripcion, normalizar, completarNumeros, SOLO_CONECTORES } from './barrios.ts';

/** Para comparar nombres de barrios: sin "barrio", "loteo", tildes ni mayúsculas. */
export const claveDeBarrio = (nombre: string) => normalizar(nombre).replace(/^(barrios?|b|bo|loteo|villa)\s+/, '');

const ROMANOS: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6' };

/** Una forma más gruesa, para lo que EPEC escribe distinto: sin artículos, letras dobles, plurales ni romanos. */
export function claveSimple(nombre: string): string {
  return claveDeBarrio(nombre)
    .split(' ')
    // Sin artículos ni "sección"/"etapa": "Santa Isabel 2ª Sección" es "Santa Isabel 2".
    .filter((p) => !/^(el|la|los|las|y|seccion|secc|sec|etapa)$/.test(p))
    // "1ra", "2da", "3er" son el número a secas: "Villa del Lago 1ra. sección" es "Villa del Lago 1".
    .map((p) => ROMANOS[p] ?? p.replace(/^(\d+)(ra|da|ta|ma|er|ro|do|to|mo|a|o)$/, '$1'))
    .map((p) => (/^\d+$/.test(p) ? p : p.replace(/(.)\1+/g, '$1').replace(/(?<=..)s$/, '')))
    .join(' ');
}

/** Cuántas letras hay que cambiar para pasar de un texto al otro (Levenshtein). */
export function distancia(a: string, b: string): number {
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(anterior[j] + 1, actual[j - 1] + 1, anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    anterior = actual;
  }
  return anterior[b.length];
}

/**
 * Los nombres de lugares de un tramo de texto, tal como los escribe EPEC (con tildes y mayúsculas):
 * "Barrios Villa Corema, Buena Vista y La Quebrada, en forma parcial." → Villa Corema, Buena Vista, La Quebrada.
 * Las descripciones por calles ("entre calles…", "sector comprendido…") no cuentan.
 */
// Palabras que marcan que empieza una descripción por calles.
const DESCRIPTIVAS = /\b(?:entre|comprendid\w*|sobre|desde|hasta|calles?|sector(?:es)?|zona|[aá]rea|frente|altura|per[ií]metro)\b/i;
// Las abreviaturas ("Dr. Cocca", "Bv. Sarmiento") y los ordinales ("1ra. y 2da. sección") no cortan la oración.
const sinPuntosDeAbreviaturas = (texto: string) => texto
  .replace(/\b(Dr|Gral|Ing|Pte|Cnel|Sta|Sto|Bv|Av|[A-Z])\.\s*/g, '$1 ')
  .replace(/\b(\d+)\s?(ra|da|ta|ma|er|ro|do|to|mo)\.\s*/gi, '$1$2 ');

/**
 * Los barrios que se nombran DESPUÉS de una descripción por calles ("área comprendida por las calles Talleres y
 * Valparaíso, de barrio Jardín"). Ahí puede haber de todo, así que solo valen si después se encuentran en el mapa:
 * nunca quedan como "sin ubicar".
 */
export function barriosEnDescripcion(texto: string): string[] {
  const nombres: string[] = [];
  for (const oracion of sinPuntosDeAbreviaturas(texto).split(/[.;]\s+|\.$/)) {
    const inicio = oracion.search(DESCRIPTIVAS);
    if (inicio < 0) continue;
    for (const m of oracion.slice(inicio).matchAll(/\b(?:barrios?|b°|bº)\s*:?\s+(.+?)(?=\s+barrios?\b|$)/gi)) {
      nombres.push(...m[1].split(DESCRIPTIVAS)[0].split(/,|\s+y\s+/).map((p) => p.trim()).filter((p) => p.length > 2));
    }
  }
  return nombres;
}

export function nombresDelTramo(texto: string): string[] {
  return sinPuntosDeAbreviaturas(texto)
    .split(/[.;]\s+|\.$/)
    // Desde que empieza una descripción por calles, el resto de la oración ya no son nombres de barrios.
    .map((oracion) => oracion.split(DESCRIPTIVAS)[0])
    .flatMap((oracion) => completarNumeros(oracion.replace(/\ben forma (parcial|total)\b/gi, '').split(/,|\s+y\s+|\s+e\s+(?=h?i)/i)))
    // Lo que viene antes de "barrio(s)" no es parte del nombre ("La Calera: sin suministro en barrios Covicco").
    .map((p) => p.replace(/^.*\b(barrios?|b°|bº|loteos?)\s*:?\s+/i, '').replace(/[()]/g, '').trim())
    .filter((p) => p.length > 2 && p.split(/\s+/).length <= 6 && !/\d\s*hs\b/i.test(p) && !esDescripcion(normalizar(p)) && !SOLO_CONECTORES.test(p));
}

// alias: otros nombres del mismo barrio (de los repetidos que se juntaron, ver sinRepetidos en barrios-interior).
export type BarrioConocido = { nombre: string; base: string; localidad: string; alias?: string[] };

/**
 * Prepara el buscador con los barrios del interior. Devuelve una función que, dadas las localidades de un tramo y su
 * texto, dice qué barrios del mapa nombra y qué nombres no se encontraron.
 */
export function crearBuscadorDeBarrios(conocidos: BarrioConocido[], alias: Record<string, string | null> = {}) {
  // Alias del interior (data/alias-interior.json): "2 Hermanos (San Francisco)" → "Dos Hermanos (San Francisco)".
  const porNombre = new Map(conocidos.map((b) => [b.nombre, b]));
  const barrios = [...conocidos, ...conocidos.flatMap((b) => (b.alias ?? []).map((a) => ({ ...b, base: a })))];
  for (const [dicho, enMapa] of Object.entries(alias)) {
    const destino = enMapa ? porNombre.get(enMapa) : undefined;
    const partes = dicho.match(/^(.+) \((.+)\)$/);
    if (destino && partes?.[2] === destino.localidad) barrios.push({ ...destino, base: partes[1] });
  }
  const porLocalidad = new Map<string, (BarrioConocido & { clave: string; simple: string })[]>();
  for (const b of barrios) {
    const lista = porLocalidad.get(b.localidad) ?? porLocalidad.set(b.localidad, []).get(b.localidad)!;
    lista.push({ ...b, clave: claveDeBarrio(b.base), simple: claveSimple(b.base) });
  }

  /**
   * Los barrios que corresponden a un nombre, o null. Primero exacto, después cada vez más tolerante, siempre único
   * en cada localidad. Si el anuncio nombra dos localidades y las dos tienen ese barrio ("La Isla" en Alta Gracia y
   * en Los Aromos), van los dos: el corte abarca a ambas.
   */
  function buscarUno(candidatos: (BarrioConocido & { clave: string; simple: string })[], nombre: string): string[] | null {
    const unico = (lista: typeof candidatos) => {
      const porLocalidad = new Map<string, Set<string>>();
      for (const c of lista) (porLocalidad.get(c.localidad) ?? porLocalidad.set(c.localidad, new Set()).get(c.localidad)!).add(c.nombre);
      return [...porLocalidad.values()].every((s) => s.size === 1) ? [...porLocalidad.values()].map((s) => [...s][0]) : null;
    };
    const clave = claveDeBarrio(nombre);
    const simple = claveSimple(nombre);
    if (!simple) return null;
    const exactos = candidatos.filter((c) => c.clave === clave);
    if (exactos.length) return unico(exactos);
    const parecidos = candidatos.filter((c) => c.simple === simple);
    if (parecidos.length) return unico(parecidos);
    // "Minetti 3" → "Minetti", si no hay otro Minetti.
    const sinNumero = simple.replace(/\s+\d+$/, '');
    if (sinNumero !== simple) {
      const sinNumeros = candidatos.filter((c) => c.simple.replace(/\s+\d+$/, '') === sinNumero);
      if (sinNumeros.length) return unico(sinNumeros);
    }
    // Una o dos letras de diferencia en nombres largos ("Estoecklin" y "Stoecklin").
    const tolerancia = simple.length >= 10 ? 2 : simple.length >= 6 ? 1 : 0;
    if (tolerancia === 0) return null;
    const cercanos = candidatos.filter((c) => Math.abs(c.simple.length - simple.length) <= tolerancia && distancia(c.simple, simple) <= tolerancia);
    return cercanos.length ? unico(cercanos) : null;
  }

  return function buscar(localidades: string[], texto: string): { barrios: string[]; sinUbicar: string[] } {
    const candidatos = localidades.flatMap((l) => porLocalidad.get(l) ?? []);
    const encontrados = new Set<string>();
    const sinUbicar: string[] = [];
    for (const nombre of nombresDelTramo(texto)) {
      const barrios = buscarUno(candidatos, nombre);
      if (barrios) barrios.forEach((b) => encontrados.add(b));
      else sinUbicar.push(nombre);
    }
    for (const nombre of barriosEnDescripcion(texto)) buscarUno(candidatos, nombre)?.forEach((b) => encontrados.add(b));
    return { barrios: [...encontrados], sinUbicar };
  };
}
