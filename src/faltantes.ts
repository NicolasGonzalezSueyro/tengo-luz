// Los lugares que nombra EPEC y el mapa no encuentra (npm run faltantes; lo corre solo `npm run editor`).
// Escribe data/lugares-faltantes.json, que el editor muestra como lista para dibujarlos a mano, empezando por los
// que más se repiten. No busca nada en internet: usa los mapas y las localidades ya guardadas.

import { readFile, writeFile } from 'node:fs/promises';
import { crearUbicador, esDescripcion, normalizar } from './barrios.ts';
import { crearUbicadorDeLocalidades, tramosDelCorte, type Candidato, type Localidad, localidadesComoBarrios } from './localidades.ts';
import { CAPITAL } from './mantenimiento.ts';
import { crearBuscadorDeBarrios, type BarrioConocido } from './nombres.ts';

export type Faltante = { nombre: string; localidad: string; veces: number };
const leer = async <T>(archivo: string, siNoEsta?: T): Promise<T> =>
  JSON.parse(await readFile(archivo, 'utf8').catch((e) => { if (siNoEsta !== undefined) return JSON.stringify(siNoEsta); throw e; }));

const zonas = await leer<{ features: Localidad[] }>('data/zonas.geojson');
const mapa = await leer<{ features: { properties: { nombre: string | null } }[] }>('data/barrios.geojson');
const alias = await leer<Record<string, string | null>>('data/alias-barrios.json');
const buscadas = await leer<Record<string, Candidato[]>>('data/localidades-buscadas.json', {});
const cortes = await leer<{ localidad?: string; zona: string }[]>('data/mantenimientos.json');
const interior = await leer<{ features: { properties: BarrioConocido }[] }>('data/barrios-interior.geojson', { features: [] });

const sinRed = { buscar: async () => [] as Candidato[], geometria: async () => ({ type: 'Polygon', coordinates: [] }) };
const ubicarLocalidades = crearUbicadorDeLocalidades(zonas.features, { ...buscadas }, sinRed);
const buscarEnInterior = crearBuscadorDeBarrios([...interior.features.map((f) => f.properties), ...localidadesComoBarrios(zonas.features)], await leer<Record<string, string | null>>('data/alias-interior.json', {}));
const nombresCapital = mapa.features.flatMap((f) => f.properties.nombre ?? []);
const ubicarEnCapital = crearUbicador(nombresCapital, alias);
const buscarEnCapital = crearBuscadorDeBarrios([
  ...nombresCapital.map((n) => ({ nombre: n, base: n, localidad: CAPITAL })),
  ...interior.features.map((f) => f.properties).filter((b) => b.localidad === CAPITAL),
]);
const ignorados = new Set(Object.keys(alias).filter((n) => alias[n] === null).map(normalizar));
// Frases que no son lugares: "corte total en toda la localidad", "IPEM Nº 203"…
// También restos del texto del anuncio: "además algunos usuarios de", "dentro del horario consignado", "manera parcial".
const NO_ES_LUGAR = /\b(corte total|toda la localidad|ambas localidades|todos los barrios|en forma (total|parcial)|manera parcial|usuarios|adem[aá]s|horario)\b|\d{2,}/i;

const cuenta = new Map<string, Faltante>();
const sumar = (nombre: string, localidad: string) => {
  const limpio = nombre.trim().replace(/\s*:$/, '').replace(/\s+/g, ' ');
  if (limpio.length < 3 || NO_ES_LUGAR.test(limpio) || limpio.split(' ').length > 5) return;
  const bonito = limpio === limpio.toLowerCase() ? limpio.replace(/(^|\s)\p{L}/gu, (l) => l.toUpperCase()) : limpio;
  const clave = `${localidad}|${normalizar(limpio)}`;
  const anterior = cuenta.get(clave);
  cuenta.set(clave, { nombre: anterior?.nombre ?? bonito, localidad, veces: (anterior?.veces ?? 0) + 1 });
};

for (const c of cortes) {
  const localidad = c.localidad ?? CAPITAL;
  if (localidad === CAPITAL) {
    for (const pedazo of ubicarEnCapital(c.zona).sinUbicar) {
      if (esDescripcion(pedazo) || ignorados.has(pedazo) || /^\d/.test(pedazo)) continue;
      if (buscarEnCapital([CAPITAL], pedazo).barrios.length === 0) sumar(pedazo, CAPITAL);
    }
    continue;
  }
  for (const tramo of tramosDelCorte(localidad, c.zona)) {
    const { localidades } = await ubicarLocalidades(tramo.nombres);
    if (localidades.length === 0) continue;
    // Si el tramo nombra varias localidades, el lugar se anota en la primera (el editor deja cambiarla).
    for (const s of buscarEnInterior(localidades, tramo.texto).sinUbicar) sumar(s, localidades[0]);
  }
}

const faltantes = [...cuenta.values()].sort((a, b) => b.veces - a.veces || a.localidad.localeCompare(b.localidad, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
await writeFile('data/lugares-faltantes.json', JSON.stringify(faltantes, null, 1) + '\n');
console.log(`📋 data/lugares-faltantes.json: ${faltantes.length} lugares que nombra EPEC y faltan en el mapa`);
