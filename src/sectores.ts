// El sector exacto de un corte que EPEC describe por calles o lugares ("Sector comprendido por calles Alberdi,
// Caseros, Alvear…", "Edificio Stefano IV, Teatro del Lago…", "barrios Don Bosco, Villa Oviedo…").
//
// 1. Se separa el texto en calles, lugares y barrios.
// 2. Se buscan en OpenStreetMap, solo dentro de la zona del corte (la localidad, o los barrios en capital).
// 3. Con las esquinas donde se cruzan esas calles (y los lugares encontrados) se dibuja el área que encierran.
//
// No es el límite oficial (EPEC no lo publica): es una aproximación mucho más precisa que marcar la localidad
// entera. Si no se puede armar, se devuelve null y el mapa marca la localidad completa como antes.

import { corredor, envolventeConvexa } from './descargar-zonas.ts';

type Punto = [number, number]; // [longitud, latitud]
export type Piezas = { calles: string[]; lugares: string[]; barrios: string[] };
/** [sur, oeste, norte, este], como lo pide Overpass. */
export type Caja = [number, number, number, number];

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };

/** Para comparar nombres de OpenStreetMap con los del anuncio: sin tildes, minúsculas, sin puntos. */
const simple = (texto: string) =>
  texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Separa el texto del corte en calles, lugares y barrios. Las palabras "calles" y "barrios" cambian de grupo;
 * lo que viene antes de cualquiera de ellas son lugares ("Edificio Stefano IV, Teatro del Lago").
 * "calle X entre A y B" son tres calles.
 */
export function piezasDelTexto(zona: string): Piezas {
  // "corte total en la localidad": no hay sector, es la localidad entera.
  if (/\b(en|toda) la localidad\b/i.test(zona)) return { calles: [], lugares: [], barrios: [] };
  const texto = zona
    .replace(/,?\s*en forma (parcial|total)\.?/gi, '')
    .replace(/^localidades? de [^:]*:\s*/i, '') // "Localidades de Alta Gracia, Los Aromos: barrios …"
    .replace(/\b(sector|[áa]rea|zona)\s+comprendid[oa]s?\s+(por|entre)\s+(las\s+)?/gi, '')
    .replace(/\bcomprendid[oa]s?\s+(por|entre)\s+(las\s+)?/gi, '')
    .replace(/\.$/, '');

  const piezas: Piezas = { calles: [], lugares: [], barrios: [] };
  let grupo: keyof Piezas = 'lugares';
  for (let pedazo of texto.split(/,\s*|\s+y\s+|\s+e\s+|\s+entre\s+/i)) {
    pedazo = pedazo.trim().replace(/^entre\s+/i, ''); // "calle X, entre A y B": el "entre" queda pegado después de la coma
    const cambio = pedazo.match(/^(calles?|barrios?:?)\s+(.*)$/i);
    if (cambio) {
      grupo = /^calle/i.test(cambio[1]) ? 'calles' : 'barrios';
      pedazo = cambio[2].replace(/^:\s*/, '');
    }
    pedazo = pedazo.replace(/\s+al\s+\d+.*$/i, '').trim(); // "Guardias Nacionales al 1380"
    if (simple(pedazo).length >= 3) piezas[grupo].push(pedazo);
  }
  // Un texto que es solo una lista ("Alberdi, Caseros y Alvear") sin la palabra "calles" se toma como calles
  // si hay al menos dos: no hay forma de saber si son lugares, y las calles son lo más común.
  if (piezas.calles.length === 0 && piezas.barrios.length === 0 && piezas.lugares.length >= 2 && !/\b(edificio|teatro|terminal|iglesia|escuela|hospital|plaza|club)\b/i.test(texto)) {
    return { calles: piezas.lugares, lugares: [], barrios: [] };
  }
  return piezas;
}

/**
 * La parte del nombre que sirve para buscar la calle: sin "Avenida", "Bv.", iniciales ("M. P. Cabrera" → "Cabrera")
 * ni un "de"/"de los" al principio (EPEC dice "Bv. de los Alemanes" y OpenStreetMap "Bulevar Los Alemanes").
 * OpenStreetMap suele tener el nombre completo ("Juan Bautista Alberdi"), así que se busca si lo contiene.
 */
export function nucleoDeCalle(nombre: string): string {
  return simple(
    nombre
      .replace(/^(avenida|av\.?|avda\.?|bv\.?|boulevard|bulevar|calle|pasaje|psje\.?|diagonal|ruta)\s+/i, '')
      .replace(/\b[A-ZÁÉÍÓÚ]\.\s*/g, '')
      .replace(/^(de|del)\s+/i, ''),
  );
}

/** Una expresión regular para Overpass que no distingue tildes ni mayúsculas ("Ómnibus" = "omnibus"). */
function sinTildes(texto: string): string {
  const variantes: Record<string, string> = { a: '[aáAÁ]', e: '[eéEÉ]', i: '[iíIÍ]', o: '[oóOÓ]', u: '[uúüUÚÜ]', n: '[nñNÑ]' };
  return simple(texto)
    .replace(/[.*+?^${}()|[\]\\]/g, '')
    .split('')
    .map((letra) => variantes[letra] ?? (/[a-z]/.test(letra) ? `[${letra}${letra.toUpperCase()}]` : letra === ' ' ? '.' : letra))
    .join('');
}

/** Dónde se cruzan dos segmentos, o null si no se cruzan (en grados: alcanza para distancias de una ciudad). */
function cruce([a, b]: [Punto, Punto], [c, d]: [Punto, Punto]): Punto | null {
  const denominador = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (denominador === 0) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominador;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominador;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] : null;
}

/**
 * Si el punto queda a menos de `metros` del segmento, devuelve el punto (si no, null). Sirve para las calles que
 * "mueren" contra otra (una T): en OpenStreetMap el final a veces queda a unos metros, sin tocarla exactamente.
 */
function pegadoA(p: Punto, [a, b]: [Punto, Punto], metros = 15): Punto | null {
  const escala = Math.cos((p[1] * Math.PI) / 180); // un grado de longitud mide menos que uno de latitud
  const [ax, ay, bx, by, px, py] = [a[0] * escala, a[1], b[0] * escala, b[1], p[0] * escala, p[1]];
  const largo = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = largo === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / largo));
  const distancia = Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))) * 110_540;
  return distancia <= metros ? p : null;
}

/** Las esquinas: los puntos donde se cruzan (o se tocan en T) calles de nombres distintos. */
export function esquinas(calles: Map<string, Punto[][]>): Punto[] {
  const nombres = [...calles.keys()];
  const puntos: Punto[] = [];
  // Dos calles pueden compartir varios tramos en la misma esquina: no repetimos puntos a menos de ~20 m.
  const agregar = (p: Punto | null) => {
    if (p && !puntos.some((q) => Math.abs(q[0] - p[0]) < 0.0002 && Math.abs(q[1] - p[1]) < 0.0002)) puntos.push(p);
  };
  for (const [i, a] of nombres.entries()) {
    for (const b of nombres.slice(i + 1)) {
      for (const lineaA of calles.get(a) ?? []) {
        for (const lineaB of calles.get(b) ?? []) {
          for (let y = 1; y < lineaB.length; y++) {
            const tramoB: [Punto, Punto] = [lineaB[y - 1], lineaB[y]];
            for (let x = 1; x < lineaA.length; x++) agregar(cruce([lineaA[x - 1], lineaA[x]], tramoB));
            // Los extremos de A pegados a B, y al revés (las T).
            agregar(pegadoA(lineaA[0], tramoB) ?? pegadoA(lineaA[lineaA.length - 1], tramoB));
          }
          for (let x = 1; x < lineaA.length; x++) {
            const tramoA: [Punto, Punto] = [lineaA[x - 1], lineaA[x]];
            agregar(pegadoA(lineaB[0], tramoA) ?? pegadoA(lineaB[lineaB.length - 1], tramoA));
          }
        }
      }
    }
  }
  return puntos;
}

/** Distancia aproximada en metros entre dos puntos cercanos (alcanza para una ciudad). */
const metrosEntre = ([lon1, lat1]: Punto, [lon2, lat2]: Punto) =>
  Math.hypot((lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110_540);

/**
 * Saca los puntos sueltos: una "Belgrano y Florida" en la otra punta de la ciudad (calles con el mismo nombre)
 * estiraría el sector. Se mide la distancia de cada punto al centro del grupo (la mediana) y se descartan los que
 * están mucho más lejos que el resto.
 */
export function sinPuntosSueltos(puntos: Punto[]): Punto[] {
  if (puntos.length < 3) return puntos;
  const mediana = (valores: number[]) => [...valores].sort((a, b) => a - b)[Math.floor(valores.length / 2)];
  const centro: Punto = [mediana(puntos.map((p) => p[0])), mediana(puntos.map((p) => p[1]))];
  const distancias = puntos.map((p) => metrosEntre(p, centro));
  const limite = Math.max(800, 2.5 * mediana(distancias));
  return puntos.filter((_, i) => distancias[i] <= limite);
}

/** Superficie aproximada de un contorno, en grados² (solo para comparar tamaños). */
const superficie = (anillo: Punto[]) => Math.abs(anillo.reduce((s, [x1, y1], i) => {
  const [x2, y2] = anillo[(i + 1) % anillo.length];
  return s + x1 * y2 - x2 * y1;
}, 0)) / 2;

/**
 * El área del corte a partir de las esquinas y los lugares encontrados. Cuantos menos puntos, más margen alrededor.
 * Devuelve null si no hay nada, o si el área terminaría ocupando más de la mitad de la zona (entonces no aporta).
 */
export function armarSector(esquinasEncontradas: Punto[], lugares: Punto[], barrios: Punto[], caja: Caja): Punto[] | null {
  const puntos = [...esquinasEncontradas, ...lugares, ...barrios];
  if (puntos.length === 0) return null;
  const metros = barrios.length > 0 ? 300 : lugares.length > 0 ? 150 : esquinasEncontradas.length >= 3 ? 40 : esquinasEncontradas.length === 2 ? 60 : 120;
  const contorno = corredor(puntos, metros).map(([lon, lat]): Punto => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  const [sur, oeste, norte, este] = caja;
  const deLaZona = superficie(envolventeConvexa([[oeste, sur], [este, sur], [este, norte], [oeste, norte]]));
  return superficie(contorno) > deLaZona / 2 ? null : contorno;
}

/** Lo que devuelve Overpass: calles con su recorrido (geometry), y lugares con su centro o su posición. */
type Elemento = {
  tags?: { name?: string; highway?: string };
  geometry?: { lat: number; lon: number }[];
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
};

/** Busca en OpenStreetMap las calles, lugares y barrios del corte, dentro de la caja. Puede fallar si Overpass no responde. */
async function buscarEnOsm(piezas: Piezas, [sur, oeste, norte, este]: Caja) {
  const caja = `(${sur},${oeste},${norte},${este})`;
  const patron = (nombres: string[]) => nombres.map(sinTildes).join('|');
  const consultas = [
    piezas.calles.length > 0 && `way["highway"]["name"~"${patron(piezas.calles.map(nucleoDeCalle))}"]${caja}->.calles; .calles out geom;`,
    piezas.lugares.length + piezas.barrios.length > 0 && `nwr["name"~"${patron([...piezas.lugares, ...piezas.barrios])}"]${caja}->.lugares; .lugares out center;`,
  ].filter(Boolean);
  // Overpass es gratuito y compartido: si está ocupado o nos pide esperar, reintentamos con calma.
  for (let intento = 1; ; intento++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: IDENTIFICACION,
      body: new URLSearchParams({ data: `[out:json][timeout:60];${consultas.join('')}` }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) return ((await res.json()) as { elements: Elemento[] }).elements;
    if (intento === 4 || ![429, 502, 503, 504].includes(res.status)) throw new Error(`Overpass respondió ${res.status}`);
    await new Promise((listo) => setTimeout(listo, intento * 15_000));
  }
}

/**
 * El sector del corte, o null si no se puede armar. Tira error si falla la conexión (para reintentar otra vez).
 * `dentro` dice si un punto pertenece a la zona (por ejemplo, el límite de la localidad): un mismo corte puede
 * nombrar barrios de pueblos vecinos ("Localidades de Alta Gracia, Los Aromos…"), y esos no cuentan.
 */
export async function sectorDelCorte(
  zona: string,
  caja: Caja,
  dentro: (p: Punto) => boolean = () => true,
  { conBarrios = true } = {},
): Promise<Punto[] | null> {
  // En capital los barrios ya se ubican con el mapa oficial: del texto solo interesan las calles y lugares.
  const piezas = { ...piezasDelTexto(zona), ...(conBarrios ? {} : { barrios: [] }) };
  if (piezas.calles.length + piezas.lugares.length + piezas.barrios.length === 0) return null;
  const elementos = await buscarEnOsm(piezas, caja);

  // Cada calle del anuncio con los tramos de OpenStreetMap cuyo nombre la contiene.
  const calles = new Map<string, Punto[][]>();
  for (const calle of piezas.calles) {
    const nucleo = nucleoDeCalle(calle);
    const tramos = elementos
      .filter((e) => e.tags?.highway && e.geometry && simple(e.tags.name ?? '').includes(nucleo))
      .map((e) => e.geometry!.map((p): Punto => [p.lon, p.lat]));
    if (tramos.length > 0) calles.set(nucleo, tramos);
  }
  const posicion = (e: Elemento): Punto | null => (e.center ? [e.center.lon, e.center.lat] : e.lat !== undefined ? [e.lon!, e.lat] : null);
  const encontrados = (nombres: string[]) => nombres.flatMap((nombre) => {
    const e = elementos.find((x) => !x.geometry && simple(x.tags?.name ?? '').includes(simple(nombre)));
    const p = e && posicion(e);
    return p ? [p] : [];
  });
  // Primero solo lo que cae dentro de la zona; después, sin los puntos sueltos (mirando todos juntos).
  const [e, l, b] = [esquinas(calles), encontrados(piezas.lugares), encontrados(piezas.barrios)].map((ps) => ps.filter(dentro));
  // Si el anuncio nombra barrios y encontramos menos de la mitad, un sector chico sería engañoso
  // (los vecinos de los barrios que faltan creerían que no les cortan): mejor marcar la localidad entera.
  if (piezas.barrios.length > 0 && b.length < piezas.barrios.length / 2) return null;
  const quedan = new Set(sinPuntosSueltos([...e, ...l, ...b]));
  const filtrar = (ps: Punto[]) => ps.filter((p) => quedan.has(p));
  return armarSector(filtrar(e), filtrar(l), filtrar(b), caja);
}
