// Las localidades de toda la provincia que nombran los cortes. Las de Gran Córdoba están cargadas a mano en
// data/zonas.geojson (`npm run zonas`); cualquier otra se busca la primera vez en OpenStreetMap (Nominatim)
// y se agrega a ese archivo, así el mapa crece solo cuando EPEC anuncia cortes en un pueblo nuevo.
// Datos © colaboradores de OpenStreetMap, licencia ODbL.

import { corredor, redondear } from './descargar-zonas.ts';
import { centro, distanciaKm, esDescripcion, normalizar, type Punto } from './barrios.ts';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const IDENTIFICACION = { 'User-Agent': 'tengo-luz/0.1 (+https://github.com/NicolasGonzalezSueyro/tengo-luz)' };
// Nominatim es gratuito y pide como mucho un pedido por segundo.
const pausa = () => new Promise((listo) => setTimeout(listo, 1100));

/** Un lugar de OpenStreetMap que se llama como la localidad buscada. */
export type Candidato = { nombre: string; osm: string; tipo: string; rango: number; punto: Punto; departamento: string };

type Geometria = { type: string; coordinates: unknown };
export type Localidad = {
  type: 'Feature';
  // contorno: el área es el casco urbano o se corrigió a mano (no un círculo alrededor del centro).
  properties: { nombre: string; tipo?: 'ruta' | 'localidad'; patron: string; descripcion: string; osm?: string; contorno?: boolean };
  geometry: Geometria;
};

// Pueblos y ciudades, no barrios: "General Paz" o "San Francisco" también son barrios de capital.
const TIPOS = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'locality', 'isolated_dwelling']);
// Si OpenStreetMap no tiene el límite del pueblo, se marca un círculo de este radio alrededor de su centro.
const RADIO_METROS: Record<string, number> = { city: 3000, town: 1500, village: 800 };
// Dos localidades de un mismo corte nunca están tan lejos: si pasa, alguna se ubicó mal.
const MAXIMO_KM = 80;
// Un nombre repetido se resuelve solo si uno de los pueblos queda así de cerca del resto del corte:
// ante la duda, mejor no marcarlo que marcarlo mal.
const CERCA_KM = 40;

// "Localidad de X", "Localidades de A, B y C", "En las localidades de…", "Localidad X en forma parcial", hasta ":" o ".".
const ENCABEZADO = /(?:^|[.;:]\s*)(?:en\s+)?(?:las?\s+)?localidad(?:es)?\s+(?:de\s+)?([^:.]+)/gi;

/**
 * Los nombres de localidades de un corte de fuera de capital: el título de la sección de la nota ("Villa María",
 * "Alta Gracia y Bosque Alegre") y las que nombra el texto ("Localidades de Colazo y James Craik: …").
 * Si el texto empieza diciendo de qué localidades es, manda el texto: a veces la nota lo pone bajo el título de otra.
 */
export function nombresDeLocalidades(seccion: string, zona: string): string[] {
  return [...new Set(tramosDelCorte(seccion, zona).flatMap((t) => t.nombres))];
}

/** Un pedazo del texto de un corte con las localidades a las que se refiere. */
export type Tramo = { nombres: string[]; texto: string };

/**
 * Parte el texto de un corte por localidad: lo que viene antes del primer "Localidad de X:" es de la sección de la
 * nota, y lo que sigue a cada "Localidad(es) de …:" es de esas localidades. Así los barrios de cada tramo se buscan
 * solo en su localidad: en "Barrios Centro y Covicco. Localidades de Del Campillo y Mattaldi." (bajo el título
 * "La Calera"), Centro y Covicco son de La Calera, no del sur de la provincia.
 */
export function tramosDelCorte(seccion: string, zona: string): Tramo[] {
  // Iniciales con punto ("Lucio V. Mansilla") cortarían la lista en el punto.
  const texto = zona.replace(/\b([A-Z]|Gral|Pte|Cnel|Dr|Ing|Int|Sta|Sto)\.\s*/g, '$1 ');
  const encabezados = [...texto.matchAll(ENCABEZADO)];
  const tramos: Tramo[] = [];
  const usarSeccion = encabezados[0]?.index !== 0 && !/otras localidades/i.test(seccion);
  if (usarSeccion) tramos.push({ nombres: partir(seccion), texto: texto.slice(0, encabezados[0]?.index ?? texto.length).trim() });
  encabezados.forEach((m, i) => {
    const despues = texto.slice(m.index! + m[0].length, encabezados[i + 1]?.index ?? texto.length);
    tramos.push({ nombres: partir(m[1]), texto: despues.replace(/^\s*[:.]\s*/, '').trim() });
  });
  return tramos.filter((t) => t.nombres.length > 0);
}

function partir(lista: string): string[] {
  return lista
    .replace(/\ben forma (parcial|total)\b.*$/i, '')
    .split(/,|\s+y\s+/)
    .map((n) => n.trim().replace(/^(comuna|paraje)\s+(de\s+)?/i, ''))
    .filter((n) =>
      n.length >= 3 && n.split(/\s+/).length <= 6
      && !/^(coop|cooperativa|zona|sector|barrios?|todos?|corte)\b/i.test(n)
      && !/^c[oó]rdoba( capital)?$/i.test(n)
      && !esDescripcion(normalizar(n)));
}

/** En OpenStreetMap muchos límites se llaman "Municipio de Bell Ville" o "Comuna de Ticino". */
const sinPrefijo = (nombre: string) => nombre.replace(/^(municipio|municipalidad|comuna)\s+(de\s+)?/i, '');

/** El nombre de OpenStreetMap corresponde al buscado ("Carlos Paz" es "Villa Carlos Paz"). */
const mismoNombre = (deOsm: string, buscado: string) => [normalizar(buscado), `villa ${normalizar(buscado)}`].includes(normalizar(deOsm));
/** Nombre oficial más largo ("Villa Yacanto" es "Villa Yacanto de Calamuchita"): solo si no hay uno exacto. */
const empiezaIgual = (deOsm: string, buscado: string) => normalizar(deOsm).startsWith(`${normalizar(buscado)} `);

/**
 * Entre varios pueblos con el mismo nombre (hay tres "San Antonio" en la provincia), el más cercano a las otras
 * localidades del corte. Sin esa referencia, solo si uno es claramente más grande (una ciudad contra caseríos).
 */
export function elegir(candidatos: Candidato[], cerca?: Punto): Candidato | null {
  if (candidatos.length <= 1) return candidatos[0] ?? null;
  if (cerca) {
    const [masCerca] = [...candidatos].sort((a, b) => distanciaKm(a.punto, cerca) - distanciaKm(b.punto, cerca));
    return distanciaKm(masCerca.punto, cerca) <= CERCA_KM ? masCerca : null;
  }
  const [a, b] = [...candidatos].sort((x, y) => x.rango - y.rango);
  return a.rango < b.rango ? a : null;
}

/** Los pueblos de la provincia de Córdoba que se llaman así (sin repetir el mismo lugar como punto y como límite). */
export async function buscarCandidatos(nombre: string): Promise<Candidato[]> {
  const url = new URL(`${NOMINATIM}/search`);
  url.search = new URLSearchParams({
    q: `${nombre}, Córdoba, Argentina`, countrycodes: 'ar', featureType: 'settlement', addressdetails: '1', limit: '20', format: 'jsonv2',
  }).toString();
  await pausa();
  const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
  type Resultado = {
    osm_type: string; osm_id: number; name: string; addresstype: string; place_rank: number; lat: string; lon: string;
    address?: { state?: string; state_district?: string; county?: string };
  };
  const enCordoba = ((await res.json()) as Resultado[])
    .filter((r) => r.address?.state === 'Córdoba' && TIPOS.has(r.addresstype))
    .map((r) => ({ ...r, name: sinPrefijo(r.name) }));
  const exactos = enCordoba.filter((r) => mismoNombre(r.name, nombre));
  const candidatos = (exactos.length > 0 ? exactos : enCordoba.filter((r) => empiezaIgual(r.name, nombre)))
    .map((r): Candidato => ({
      nombre: r.name,
      osm: `${r.osm_type[0].toUpperCase()}${r.osm_id}`,
      tipo: r.addresstype,
      rango: r.place_rank,
      punto: [Number(r.lon), Number(r.lat)],
      departamento: (r.address?.state_district ?? r.address?.county ?? '').replace(/^Departamento /, ''),
    }))
    // El mismo pueblo puede venir como punto, como pueblo y como municipio (todo el ejido, con campo alrededor):
    // primero los límites, y entre ellos el más chico (el de rango mayor), que es el del pueblo.
    .sort((a, b) => Number(b.osm.startsWith('R')) - Number(a.osm.startsWith('R')) || b.rango - a.rango);
  return candidatos.filter((c, i) => !candidatos.slice(0, i).some((otro) => distanciaKm(otro.punto, c.punto) < 10));
}

/** El límite del pueblo según OpenStreetMap o, si no lo tiene, un círculo alrededor de su centro. */
export async function geometriaDe(c: Candidato): Promise<Geometria> {
  if (c.osm.startsWith('R')) {
    const url = new URL(`${NOMINATIM}/lookup`);
    // polygon_threshold simplifica el contorno (~50 m de detalle): alcanza para ver el pueblo y el archivo queda liviano.
    url.search = new URLSearchParams({ osm_ids: c.osm, format: 'json', polygon_geojson: '1', polygon_threshold: '0.0005' }).toString();
    await pausa();
    const res = await fetch(url, { headers: IDENTIFICACION, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
    const [r] = (await res.json()) as { geojson?: Geometria }[];
    if (r?.geojson && ['Polygon', 'MultiPolygon'].includes(r.geojson.type)) return { type: r.geojson.type, coordinates: redondear(r.geojson.coordinates) };
  }
  return { type: 'Polygon', coordinates: [redondear(corredor([c.punto], RADIO_METROS[c.tipo] ?? 500))] };
}

const escapar = (texto: string) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Localidades cargadas a mano (data/localidades-manuales.json) para los pueblos que OpenStreetMap no tiene:
 * { "Mula Muerta": "-30.0123, -64.4567" }, con las coordenadas tal como las copia Google Maps (latitud, longitud).
 * Reemplazan lo que se haya buscado para ese nombre y se dibujan como un círculo alrededor del punto.
 * Devuelve los nombres con coordenadas inválidas o fuera de la provincia, para avisar, y si cambió algún círculo.
 */
export function aplicarManuales(zonas: Localidad[], buscadas: Record<string, Candidato[]>, manuales: Record<string, string>) {
  const invalidas: string[] = [];
  let cambiaron = false;
  for (const [nombre, texto] of Object.entries(manuales)) {
    const [lat, lon] = String(texto).split(',').map((n) => Number(n.trim()));
    // La provincia de Córdoba entra en esta caja: un número mal copiado no termina en otro lado del mapa.
    if (!(lat >= -35.1 && lat <= -29.4 && lon >= -65.8 && lon <= -61.7)) {
      invalidas.push(nombre);
      continue;
    }
    const osm = `manual:${normalizar(nombre)}`;
    const punto: Punto = [lon, lat];
    buscadas[normalizar(nombre)] = [{ nombre, osm, tipo: 'village', rango: 19, punto, departamento: '' }];
    const geometria = { type: 'Polygon', coordinates: [redondear(corredor([punto], RADIO_METROS.village))] };
    const anterior = zonas.find((z) => z.properties.osm === osm);
    if (anterior && JSON.stringify(anterior.geometry) === JSON.stringify(geometria)) continue;
    const feature: Localidad = {
      type: 'Feature',
      properties: {
        nombre: anterior?.properties.nombre ?? (zonas.some((z) => z.properties.nombre === nombre) ? `${nombre} (manual)` : nombre),
        tipo: 'localidad',
        patron: `^${escapar(normalizar(nombre))}$`,
        osm,
        descripcion: `La ubicación de ${nombre} es una referencia aproximada.`,
      },
      geometry: geometria,
    };
    if (anterior) zonas[zonas.indexOf(anterior)] = feature;
    else zonas.push(feature);
    cambiaron = true;
  }
  // Las que se borraron del archivo (por ejemplo, porque estaban mal ubicadas) salen del mapa
  // y quedan como "no encontradas", así no se vuelven a buscar ni a avisar.
  const vigentes = new Set(Object.keys(manuales).map((n) => `manual:${normalizar(n)}`));
  for (let i = zonas.length - 1; i >= 0; i--) {
    const osm = zonas[i].properties.osm ?? '';
    if (!osm.startsWith('manual:') || vigentes.has(osm)) continue;
    buscadas[osm.slice('manual:'.length)] = [];
    zonas.splice(i, 1);
    cambiaron = true;
  }
  return { invalidas, cambiaron };
}

/**
 * Ubica los nombres de localidades de un corte. Usa las que ya están en el mapa y, para las demás, lo guardado
 * en `buscadas` (nombre → candidatos) o una búsqueda nueva. Las localidades nuevas se agregan a `zonas`.
 * `red` se reemplaza en los tests para no salir a internet.
 */
export function crearUbicadorDeLocalidades(
  zonas: Localidad[],
  buscadas: Record<string, Candidato[]>,
  red = { buscar: buscarCandidatos, geometria: geometriaDe },
) {
  const conocida = (nombre: string) =>
    zonas.find((z) => z.properties.tipo === 'localidad' && new RegExp(z.properties.patron).test(normalizar(nombre)));

  return async function ubicar(nombres: string[]): Promise<{ localidades: string[]; noEncontradas: string[] }> {
    const noEncontradas: string[] = [];
    const fijas: { nombre: string; punto: Punto }[] = [];
    const dudosas: Candidato[][] = [];

    for (const nombre of nombres) {
      const clave = normalizar(nombre);
      // Lo ya buscado manda: si hay varios pueblos con ese nombre, cada corte elige el suyo por cercanía.
      const zona = clave in buscadas ? undefined : conocida(nombre);
      if (zona) {
        fijas.push({ nombre: zona.properties.nombre, punto: centro(zona.geometry) });
        continue;
      }
      if (!(clave in buscadas)) {
        buscadas[clave] = await red.buscar(nombre);
        if (buscadas[clave].length === 0) noEncontradas.push(nombre);
      }
      const candidatos = buscadas[clave];
      const elegido = elegir(candidatos);
      if (elegido && candidatos.length === 1) fijas.push({ nombre: await agregar(elegido), punto: elegido.punto });
      else if (candidatos.length > 0) dudosas.push(candidatos);
    }

    // Los nombres repetidos se resuelven por cercanía a las localidades seguras del mismo corte.
    const cerca = fijas.length > 0
      ? ([fijas.reduce((s, f) => s + f.punto[0], 0) / fijas.length, fijas.reduce((s, f) => s + f.punto[1], 0) / fijas.length] as Punto)
      : undefined;
    for (const candidatos of dudosas) {
      const elegido = elegir(candidatos, cerca);
      if (elegido) fijas.push({ nombre: await agregar(elegido), punto: elegido.punto });
    }

    // Una localidad a más de 80 km de todas las demás del corte seguramente se ubicó mal: no se marca.
    const localidades = fijas
      .filter((f) => fijas.length < 2 || fijas.some((otra) => otra !== f && distanciaKm(otra.punto, f.punto) <= MAXIMO_KM))
      .map((f) => f.nombre);
    return { localidades: [...new Set(localidades)], noEncontradas };
  };

  /** El nombre con que el candidato queda en el mapa; si todavía no está, lo agrega con su límite. */
  async function agregar(c: Candidato): Promise<string> {
    const existente = zonas.find((z) => z.properties.osm === c.osm);
    if (existente) return existente.properties.nombre;
    // Dos pueblos distintos con el mismo nombre: el segundo lleva el departamento ("La Paz (San Javier)").
    const nombre = zonas.some((z) => z.properties.nombre === c.nombre) ? `${c.nombre} (${c.departamento})` : c.nombre;
    const geometria = await red.geometria(c);
    zonas.push({
      type: 'Feature',
      properties: {
        nombre,
        tipo: 'localidad',
        patron: `^${escapar(normalizar(nombre))}$`,
        osm: c.osm,
        descripcion: !c.osm.startsWith('R')
          ? `La ubicación de ${c.nombre} es una referencia aproximada.`
          : `El anuncio no detalla barrios de ${nombre}: se marca toda la localidad como referencia.`,
      },
      geometry: geometria,
    });
    return nombre;
  }
}
