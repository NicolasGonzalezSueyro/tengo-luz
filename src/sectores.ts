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
import { distancia } from './nombres.ts';

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
    .replace(/\s*\n\s*/g, ' ') // EPEC a veces parte un renglón por la mitad
    .replace(/,?\s*(?:en|de) (?:forma|manera) (parcial|total)\.?/gi, '')
    .replace(/^localidades? de [^:]*:\s*/i, '') // "Localidades de Alta Gracia, Los Aromos: barrios …"
    // "área comprendida por las", "en el perímetro comprendido entre", "sector comprendido por"… (sin \b: no anda con "á")
    .replace(/(?<![\p{L}])(?:en\s+)?(?:(?:el|la)\s+)?(?:sector|[áa]rea|zona|per[ií]metro)\s+comprendid[oa]s?\s+(?:por+r*|entre)\s+(?:las\s+)?/giu, '')
    .replace(/\bcomprendid[oa]s?\s+(por|entre)\s+(las\s+)?/gi, '')
    .replace(/\.\s*$/, '');

  const piezas: Piezas = { calles: [], lugares: [], barrios: [] };
  let grupo: keyof Piezas = 'lugares';
  // También corta el punto antes de "barrios" o "calles" ("…y San Juan. barrios: Felipe Botta…"); los demás puntos son
  // de abreviaturas ("Bv. Roca").
  // "Entre Ríos" es una calle: ahí no se corta.
  for (let pedazo of texto.split(/,\s*|\s+y\s+|\s+e\s+|\s+entre\s+(?!r[ií]os\b)|\.\s+(?=(?:barrios?|calles?)\b)/i)) {
    // "calle X, entre A y B": el "entre" queda pegado después de la coma. "…, de barrio Jardín": el "de" también.
    pedazo = pedazo.trim().replace(/^entre\s+(?!r[ií]os\b)/i, '').replace(/^(?:de|del|en)\s+(?=barrios?\b)/i, '');
    const cambio = pedazo.match(/^(?:las\s+|los\s+)?(calles?|barrios?)\b\s*:?\s*(.*)$/i);
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

/**
 * Si un nombre de calle de OpenStreetMap es la calle del anuncio: la contiene como palabras enteras ("Colón" no es
 * "Colonia"), o cada palabra importante aparece con a lo sumo una letra de diferencia (EPEC escribe "Richieri" y
 * la calle es "Pablo Ricchieri"). Exportado para los tests.
 */
export function esLaCalle(nombreOsm: string, nucleo: string): boolean {
  const deOsm = simple(nombreOsm);
  if (` ${deOsm} `.includes(` ${nucleo} `)) return true;
  // Todas las palabras del anuncio (menos "de", "la"…) tienen que estar: "San Martín" no es "Martín Fierro".
  const delAnuncio = nucleo.split(' ').filter((p) => !/^(de|del|la|las|los|el|y)$/.test(p));
  const palabras = deOsm.split(' ');
  return delAnuncio.length > 0 && delAnuncio.every((p) => palabras.some((q) =>
    q === p || (p.length >= 6 && Math.abs(q.length - p.length) <= 1 && distancia(p, q) <= 1)));
}

/** Lo que se le pide a Overpass por cada calle: las tres primeras letras de su palabra más larga (después se elige acá). */
const pistaDeCalle = (nucleo: string) => {
  const larga = nucleo.split(' ').sort((a, b) => b.length - a.length)[0] ?? nucleo;
  return larga.length >= 6 ? larga.slice(0, 3) : nucleo;
};

const GEOREF = 'https://apis.datos.gob.ar/georef/api/direcciones';
/**
 * Las esquinas según Georef, la API oficial de direcciones (datos.gob.ar): se le pregunta por cada par de calles
 * ("Belgrano y Achával Rodríguez") dentro de la localidad. Es el segundo intento, para cuando OpenStreetMap no tiene
 * la calle o la llama distinto. Si no responde, simplemente no suma nada.
 */
async function esquinasDeGeoref(calles: string[], localidad: string): Promise<Punto[]> {
  const puntos: Punto[] = [];
  const lista = calles.slice(0, 6); // 6 calles son 15 pares: alcanza y no abusa del servicio
  for (const [i, a] of lista.entries()) {
    for (const b of lista.slice(i + 1)) {
      const url = new URL(GEOREF);
      url.search = new URLSearchParams({ direccion: `${a} y ${b}`, provincia: 'cordoba', localidad_censal: localidad, max: '3', campos: 'ubicacion.lat,ubicacion.lon' }).toString();
      const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res?.ok) continue;
      const { direcciones = [] } = (await res.json().catch(() => ({}))) as { direcciones?: { ubicacion?: { lat?: number | null; lon?: number | null } }[] };
      for (const d of direcciones) if (typeof d.ubicacion?.lat === 'number' && typeof d.ubicacion.lon === 'number') puntos.push([d.ubicacion.lon, d.ubicacion.lat]);
    }
  }
  return puntos;
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
  // 1500 m de piso: un área entre dos avenidas mide fácil un kilómetro (y la búsqueda ya se hace dentro del barrio).
  const limite = Math.max(1500, 2.5 * mediana(distancias));
  return puntos.filter((_, i) => distancias[i] <= limite);
}

/**
 * Con cuatro calles y solo tres esquinas encontradas, la cuarta se deduce: es la que cierra el rectángulo (en una
 * cuadrícula, la esquina opuesta a la del ángulo recto). Si las tres no forman algo parecido a un ángulo recto, no se
 * inventa nada. Exportado para los tests.
 */
export function cuartaEsquina(tres: Punto[]): Punto | null {
  if (tres.length !== 3) return null;
  const escala = Math.cos((tres[0][1] * Math.PI) / 180);
  const plano = tres.map(([lon, lat]): Punto => [lon * escala, lat]);
  // El coseno del ángulo en cada esquina: la del ángulo recto es la que lo tiene más cerca de cero. (En un rectángulo
  // largo, otra esquina también anda cerca de los 90°: por eso se elige la mejor y no la primera que pase.)
  const cosenos = [0, 1, 2].map((i) => {
    const [b, a, c] = [plano[i], plano[(i + 1) % 3], plano[(i + 2) % 3]];
    const [u, v] = [[a[0] - b[0], a[1] - b[1]], [c[0] - b[0], c[1] - b[1]]];
    return Math.abs((u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])));
  });
  const i = cosenos.indexOf(Math.min(...cosenos));
  // Entre 75° y 105°: la que falta está enfrente de esa esquina.
  if (!(cosenos[i] < 0.26)) return null;
  return [tres[(i + 1) % 3][0] + tres[(i + 2) % 3][0] - tres[i][0], tres[(i + 1) % 3][1] + tres[(i + 2) % 3][1] - tres[i][1]];
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
  tags?: { name?: string; highway?: string; place?: string; landuse?: string };
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
    piezas.calles.length > 0 && `way["highway"]["name"~"${patron(piezas.calles.map((c) => pistaDeCalle(nucleoDeCalle(c))))}"]${caja}->.calles; .calles out geom;`,
    piezas.lugares.length + piezas.barrios.length > 0 && `nwr["name"~"${patron([...piezas.lugares, ...piezas.barrios])}"]${caja}->.lugares; .lugares out center;`,
  ].filter(Boolean);
  // Overpass es gratuito y compartido: si está ocupado o nos pide esperar, reintentamos con calma.
  // Si el balanceador de overpass-api.de falla (502), se prueba directo con los servidores que tiene detrás.
  const servidores = [OVERPASS, 'https://gall.openstreetmap.de/api/interpreter', 'https://lambert.openstreetmap.de/api/interpreter'];
  for (let intento = 1; ; intento++) {
    const res = await fetch(servidores[(intento - 1) % servidores.length], {
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
  { conBarrios = true, localidad = '' } = {},
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
      .filter((e) => e.tags?.highway && e.geometry && esLaCalle(e.tags.name ?? '', nucleo))
      .map((e) => e.geometry!.map((p): Punto => [p.lon, p.lat]));
    if (tramos.length > 0) calles.set(nucleo, tramos);
  }
  const posicion = (e: Elemento): Punto | null => (e.center ? [e.center.lon, e.center.lat] : e.lat !== undefined ? [e.lon!, e.lat] : null);
  // Un mismo nombre puede ser una calle, un barrio y un pueblo ("Los Aromos" aparece 42 veces en Gran Córdoba).
  // Para cada nombre se toma el primer resultado del tipo correcto que cae dentro de la zona.
  const encontrados = (nombres: string[], esDelTipo: (tags: NonNullable<Elemento['tags']>) => boolean) => nombres.flatMap((nombre) => {
    for (const x of elementos) {
      if (x.geometry || !x.tags || !esDelTipo(x.tags) || !simple(x.tags.name ?? '').includes(simple(nombre))) continue;
      const p = posicion(x);
      if (p && dentro(p)) return [p];
    }
    return [];
  });
  const esBarrio = (t: NonNullable<Elemento['tags']>) => Boolean(t.place) || t.landuse === 'residential'; // "barrio Los Aromos" ≠ calle Los Aromos
  const esLugar = (t: NonNullable<Elemento['tags']>) => !t.highway; // "Teatro del Lago" nunca es una calle
  const [sur, oeste, norte, este] = caja;
  const enLaCaja = ([lon, lat]: Punto) => lat >= sur && lat <= norte && lon >= oeste && lon <= este;
  let e = esquinas(calles).filter(dentro);
  // Con menos de 3 esquinas no hay área: se le pregunta a Georef por las esquinas que falten.
  if (e.length < 3 && piezas.calles.length >= 2 && localidad) {
    const deGeoref = (await esquinasDeGeoref(piezas.calles, localidad)).filter((p) => enLaCaja(p) && dentro(p));
    e = [...e, ...deGeoref.filter((p) => !e.some((q) => metrosEntre(p, q) < 30))];
  }
  const l = encontrados(piezas.lugares, esLugar);
  // Si las calles ya encierran un área (3 esquinas o más), el sector es esa área: el barrio que nombra el anuncio
  // ("barrio Roca, área comprendida por las calles…") solo dice dónde queda, no la agranda.
  const b = e.length >= 3 ? [] : encontrados(piezas.barrios, esBarrio);
  // Si el anuncio nombra barrios y encontramos menos de la mitad, un sector chico sería engañoso
  // (los vecinos de los barrios que faltan creerían que no les cortan): mejor marcar la localidad entera.
  if (e.length < 3 && piezas.barrios.length > 0 && b.length < piezas.barrios.length / 2) return null;
  // "Área comprendida por las calles A, B, C y D" con una esquina sin encontrar: se cierra el rectángulo.
  const cuarta = piezas.calles.length === 4 ? cuartaEsquina(sinPuntosSueltos(e)) : null;
  if (cuarta && enLaCaja(cuarta)) e = [...sinPuntosSueltos(e), cuarta];
  const quedan = new Set(sinPuntosSueltos([...e, ...l, ...b]));
  const filtrar = (ps: Punto[]) => ps.filter((p) => quedan.has(p));
  return armarSector(filtrar(e), filtrar(l), filtrar(b), caja);
}
