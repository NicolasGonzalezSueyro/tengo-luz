// Contornos corregidos a mano con el editor (npm run editor): quedan en data/contornos-manuales.geojson y mandan
// sobre lo que arman los scripts. Cada script que reescribe un mapa los vuelve a aplicar antes de guardarlo, así
// una corrección no se pierde al regenerar los datos.

import { existsSync, readFileSync } from 'node:fs';
import type { MultiPolygon, Polygon } from 'geojson';

export const ARCHIVO_MANUALES = 'data/contornos-manuales.geojson';
// Los rearmados con manzanas y parcelas oficiales después de comparar con Wikimapia (src/revisar-contornos.ts).
// Se aplican antes que los manuales: si corregís uno a mano en el editor, manda lo tuyo.
export const ARCHIVO_REVISADOS = 'data/contornos-revisados.geojson';
/** En qué mapa está el lugar: barrios de capital, localidades y zonas, o barrios del interior (y lugares nuevos). */
export type Destino = 'barrios' | 'zonas' | 'interior';
export type ContornoManual = {
  type: 'Feature';
  properties: {
    nombre: string; destino: Destino; localidad?: string;
    // Cómo era antes del primer cambio, para poder volver atrás (null si es un lugar nuevo o era un punto).
    original: Polygon | MultiPolygon | null; antes?: Record<string, unknown>;
  };
  geometry: Polygon | MultiPolygon;
};
type Coleccion = { features: { properties: Record<string, unknown> & { nombre?: string | null }; geometry: unknown }[] };

// La provincia de Córdoba entra en este rectángulo: un contorno fuera de él es un error.
const CAJA = { oeste: -65.8, este: -61.7, sur: -35.1, norte: -29.4 };
const MAX_PUNTOS = 5000;

/** Valida un contorno que llega del editor: un polígono (o varios) dentro de la provincia, de tamaño razonable. */
export function contornoValido(g: unknown): g is Polygon | MultiPolygon {
  const geo = g as Polygon | MultiPolygon;
  if (!geo || (geo.type !== 'Polygon' && geo.type !== 'MultiPolygon') || !Array.isArray(geo.coordinates)) return false;
  const anillos = (geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates).flat();
  const puntos = anillos.flat();
  if (anillos.length === 0 || puntos.length > MAX_PUNTOS || anillos.some((a) => !Array.isArray(a) || a.length < 4)) return false;
  return puntos.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && p[0] >= CAJA.oeste && p[0] <= CAJA.este && p[1] >= CAJA.sur && p[1] <= CAJA.norte);
}

export function leerManuales(archivo = ARCHIVO_MANUALES): ContornoManual[] {
  if (!existsSync(archivo)) return [];
  return (JSON.parse(readFileSync(archivo, 'utf8')) as { features: ContornoManual[] }).features;
}

/**
 * Pone los contornos manuales de ese destino en la colección (la cambia ahí mismo). En el interior, un lugar que no
 * existe se agrega como barrio nuevo de su localidad.
 */
export function aplicarContornos<C extends Coleccion>(coleccion: C, destino: Destino, manuales = [...leerManuales(ARCHIVO_REVISADOS), ...leerManuales()]): C {
  for (const m of manuales.filter((m) => m.properties.destino === destino)) {
    const existentes = coleccion.features.filter((f) => f.properties.nombre === m.properties.nombre);
    for (const f of existentes) {
      f.geometry = m.geometry;
      if (destino === 'zonas') f.properties.contorno = true; // ya no es un círculo alrededor del pueblo
      else f.properties.fuente = 'manual';
      if (destino === 'interior') f.properties.tipo = 'poligono';
    }
    if (existentes.length === 0 && destino === 'interior') {
      const nombre = m.properties.nombre;
      coleccion.features.push({
        type: 'Feature',
        properties: {
          nombre, base: nombre.replace(/\s*\([^)]*\)$/, ''), localidad: m.properties.localidad ?? 'Córdoba', tipo: 'poligono', fuente: 'manual',
        },
        geometry: m.geometry,
      } as C['features'][number]);
    }
  }
  return coleccion;
}
