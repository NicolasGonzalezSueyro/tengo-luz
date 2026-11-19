// Contornos corregidos a mano con el editor del panel de admin (/admin-contornos): el robot de GitHub los aplica y
// quedan en data/contornos-manuales.geojson, que manda sobre lo que arman los scripts. Cada script que reescribe un
// mapa los vuelve a aplicar antes de guardarlo, así una corrección no se pierde al regenerar los datos.

import { existsSync, readFileSync } from 'node:fs';
import type { MultiPolygon, Polygon } from 'geojson';

export const ARCHIVO_MANUALES = 'data/contornos-manuales.geojson';
// Los rearmados con manzanas y parcelas oficiales después de comparar con Wikimapia (src/revisar-contornos.ts).
// Se aplican antes que los manuales: si corregís uno a mano en el editor, manda lo tuyo.
export const ARCHIVO_REVISADOS = 'data/contornos-revisados.geojson';
/** En qué mapa está el lugar: barrios de capital, localidades y zonas, o barrios del interior (y lugares nuevos). */
export type Destino = 'barrios' | 'zonas' | 'interior';
export const ARCHIVOS: Record<Destino, string> = { barrios: 'data/barrios.geojson', zonas: 'data/zonas.geojson', interior: 'data/barrios-interior.geojson' };
export type ContornoManual = {
  type: 'Feature';
  properties: {
    nombre: string; destino: Destino; localidad?: string;
    // Cómo era antes del primer cambio, para poder volver atrás (null si es un lugar nuevo o era un punto).
    original: Polygon | MultiPolygon | null; antes?: Record<string, unknown>;
    // Borrado desde el editor: el lugar deja de estar en el mapa (`antes` guarda todas sus propiedades para volverlo).
    borrado?: boolean;
  };
  // En un borrado, la geometría que tenía (para restaurarlo).
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
 * existe se agrega como barrio nuevo de su localidad. Un lugar borrado sale de la colección.
 */
export function aplicarContornos<C extends Coleccion>(coleccion: C, destino: Destino, manuales = [...leerManuales(ARCHIVO_REVISADOS), ...leerManuales()]): C {
  // Un borrado vale en todos los mapas: un barrio de capital que era un punto también está en barrios.geojson.
  for (const m of manuales.filter((m) => m.properties.destino === destino || m.properties.borrado)) {
    if (m.properties.borrado) {
      coleccion.features = coleccion.features.filter((f) => f.properties.nombre !== m.properties.nombre);
      continue;
    }
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

/** Lo que manda el editor: un contorno nuevo o corregido, borrar un lugar, o volverlo a como estaba. */
export type PedidoDeContorno = {
  accion: 'contorno' | 'borrar' | 'restaurar';
  nombre: string;
  destino: Destino;
  localidad?: string;
  geometria?: Polygon | MultiPolygon;
};

/** Valida un pedido que llega de afuera. Devuelve el pedido limpio o el motivo del rechazo. */
export function pedidoValido(valor: unknown): PedidoDeContorno | string {
  const p = valor as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return 'Pedido inválido';
  if (!['contorno', 'borrar', 'restaurar'].includes(p.accion as string)) return 'Acción desconocida';
  const nombre = typeof p.nombre === 'string' ? p.nombre.trim() : '';
  if (!nombre || nombre.length > 120) return 'Falta el nombre del lugar (hasta 120 letras).';
  if (!['barrios', 'zonas', 'interior'].includes(p.destino as string)) return 'No sé en qué mapa va ese lugar.';
  const localidad = typeof p.localidad === 'string' && p.localidad.trim() ? p.localidad.trim().slice(0, 80) : undefined;
  if (p.accion === 'contorno' && !contornoValido(p.geometria)) return 'El contorno tiene que ser un polígono dentro de la provincia (hasta 5000 puntos).';
  return {
    accion: p.accion as PedidoDeContorno['accion'], nombre, destino: p.destino as Destino, ...(localidad ? { localidad } : {}),
    ...(p.accion === 'contorno' ? { geometria: p.geometria as Polygon | MultiPolygon } : {}),
  };
}

/**
 * Aplica un pedido del editor: cambia la lista de manuales y el mapa de su destino ahí mismo, y devuelve qué hizo.
 * Las demás correcciones se reaplican después con aplicarContornos (así el orden de los pedidos no importa).
 */
export function aplicarPedido(manuales: ContornoManual[], mapa: Coleccion, pedido: PedidoDeContorno): { manuales: ContornoManual[]; mensaje: string } {
  const { nombre, destino } = pedido;
  const anterior = manuales.find((m) => m.properties.nombre === nombre && m.properties.destino === destino);
  const otros = manuales.filter((m) => m !== anterior);
  const actual = mapa.features.find((f) => f.properties.nombre === nombre);

  if (pedido.accion === 'restaurar') {
    if (!anterior) return { manuales, mensaje: `${nombre} ya tenía su contorno original.` };
    const { original, antes = {}, borrado } = anterior.properties;
    if (borrado) {
      if (!actual) mapa.features.push({ type: 'Feature', properties: { ...antes }, geometry: anterior.geometry } as Coleccion['features'][number]);
    } else if (original) {
      for (const f of mapa.features.filter((f) => f.properties.nombre === nombre)) {
        f.geometry = original;
        for (const clave of ['fuente', 'tipo', 'contorno']) {
          if (antes[clave] === undefined) delete f.properties[clave];
          else f.properties[clave] = antes[clave];
        }
      }
    } else {
      mapa.features = mapa.features.filter((f) => f.properties.nombre !== nombre); // era un lugar nuevo
    }
    return { manuales: otros, mensaje: `${nombre} volvió a como estaba.` };
  }

  if (pedido.accion === 'borrar') {
    // Un lugar nuevo (dibujado a mano): se va del todo, no hay nada que recordar para volver.
    if (anterior && !anterior.properties.borrado && !anterior.properties.original && !anterior.properties.antes) {
      mapa.features = mapa.features.filter((f) => f.properties.nombre !== nombre);
      return { manuales: otros, mensaje: `Borré ${nombre}.` };
    }
    // Lo que había antes de cualquier cambio a mano, para poder volver atrás.
    const geometria = (anterior?.properties.original ?? (actual?.geometry as ContornoManual['geometry'] | undefined)) ?? anterior?.geometry;
    if (!geometria || !/Polygon$/.test(geometria.type)) {
      // Un lugar nuevo (dibujado a mano) o un punto: no hay nada que guardar para volver.
      mapa.features = mapa.features.filter((f) => f.properties.nombre !== nombre);
      return { manuales: otros, mensaje: `Borré ${nombre}.` };
    }
    const antes = anterior?.properties.antes && !anterior.properties.original ? anterior.properties.antes : { ...(actual?.properties ?? { nombre }) };
    mapa.features = mapa.features.filter((f) => f.properties.nombre !== nombre);
    return {
      manuales: [...otros, { type: 'Feature', properties: { nombre, destino, ...(pedido.localidad ? { localidad: pedido.localidad } : {}), original: null, antes, borrado: true }, geometry: geometria }],
      mensaje: `Borré ${nombre}.`,
    };
  }

  // El original se guarda la primera vez, para poder volver atrás (null si es un lugar nuevo o era un punto).
  const conContorno = actual && /Polygon$/.test((actual.geometry as { type: string }).type) ? actual : undefined;
  const original = anterior && !anterior.properties.borrado ? anterior.properties.original : ((conContorno?.geometry as ContornoManual['properties']['original']) ?? null);
  const antes = anterior && !anterior.properties.borrado ? anterior.properties.antes
    : conContorno && { fuente: conContorno.properties.fuente, tipo: conContorno.properties.tipo, contorno: conContorno.properties.contorno };
  const nuevo: ContornoManual = {
    type: 'Feature',
    properties: { nombre, destino, ...(pedido.localidad ? { localidad: pedido.localidad } : {}), original, ...(antes ? { antes } : {}) },
    geometry: pedido.geometria!,
  };
  return { manuales: [...otros, nuevo], mensaje: `Guardé el contorno de ${nombre}.` };
}
