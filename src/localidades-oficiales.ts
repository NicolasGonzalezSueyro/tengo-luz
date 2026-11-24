// Agrega al mapa localidades de la provincia con los datos oficiales de la Provincia (Mapas Córdoba, IDECOR): el radio
// urbano como contorno, o el punto oficial si no tiene radio. Sirve para las que nombran EPEC en sus fallas y todavía
// no están (el lector solo agrega las que aparecen en los cortes programados).
//   npm run localidades-oficiales -- "Cruz Alta" "Morrison" "General Deheza|JUÁREZ CELMAN" …
// (con "|departamento" se elige entre localidades que se llaman igual). Después: data/zonas.geojson y data/lugares.js.

import { readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import { normalizar, separarDeLocalidades } from './barrios.ts';
import { escapar, type Localidad } from './localidades.ts';
import { escribirLugares } from './lugares.ts';
import { radiosUrbanos, unir, type Area } from './barrios-interior.ts';

type Punto = { properties: { localidad: string; departamento: string }; geometry: { coordinates: [number, number] } };

/** El nombre sin tildes ni mayúsculas, para comparar con los datos de la Provincia (vienen en MAYÚSCULAS). */
const clave = (n: string) => normalizar(n).replace(/^(municipalidad|municipio|comuna) de /, '');

/** La localidad nueva, lista para data/zonas.geojson. Exportado para los tests. */
export function localidadOficial(nombre: string, radio: Area | null, punto: [number, number] | null): Localidad | null {
  if (!radio && !punto) return null;
  const geometria = radio?.geometry ?? turf.circle(punto!, 1.2, { units: 'kilometers', steps: 32 }).geometry;
  return {
    type: 'Feature',
    properties: {
      nombre,
      tipo: 'localidad',
      patron: `^${escapar(normalizar(nombre))}$`,
      descripcion: radio
        ? `El área marcada es el radio urbano oficial de ${nombre} (Provincia de Córdoba). Es una referencia.`
        : `La ubicación de ${nombre} es una referencia aproximada.`,
      // Con radio, se dibuja el área; sin radio, un punto (la página dibuja así lo que no viene de un límite de OSM).
      ...(radio ? { contorno: true } : { osm: 'IDECOR' }),
    },
    geometry: geometria as Localidad['geometry'],
  };
}

if (import.meta.main) {
  const pedidos = process.argv.slice(2);
  if (pedidos.length === 0) throw new Error('Uso: npm run localidades-oficiales -- "Nombre" "Otro|DEPARTAMENTO" …');
  const zonas = JSON.parse(await readFile('data/zonas.geojson', 'utf8')) as { type: string; features: Localidad[] };
  const puntos = (JSON.parse(await readFile('.cache/barrios-interior/idecor-localidad_punto.json', 'utf8')) as { features: Punto[] }).features;
  const radios = await radiosUrbanos();
  const yaEstan = new Set(zonas.features.map((z) => clave(z.properties.nombre)));
  for (const pedido of pedidos) {
    const [nombre, departamento] = pedido.split('|');
    if (yaEstan.has(clave(nombre))) {
      console.log(`= ${nombre}: ya está en el mapa`);
      continue;
    }
    const candidatos = puntos.filter((p) => clave(p.properties.localidad) === clave(nombre)
      && (!departamento || clave(p.properties.departamento) === clave(departamento)));
    if (candidatos.length > 1) {
      console.log(`? ${nombre}: hay ${candidatos.length} con ese nombre (${candidatos.map((c) => c.properties.departamento).join(', ')}): agregá "|DEPARTAMENTO"`);
      continue;
    }
    // Los puntos de la Provincia vienen como MultiPoint ([[lon, lat]]).
    const coordenadas = candidatos[0]?.geometry.coordinates as unknown as [number, number] | [number, number][] | undefined;
    const punto = coordenadas ? (Array.isArray(coordenadas[0]) ? (coordenadas[0] as [number, number]) : (coordenadas as [number, number])) : null;
    // El radio con ese nombre; si hay varios (dos pueblos homónimos), el que contiene el punto oficial.
    const conNombre = radios.get(normalizar(nombre)) ?? [];
    const delPunto = punto ? conNombre.filter((r) => turf.booleanPointInPolygon(punto, r)) : conNombre.length === 1 ? conNombre : [];
    const localidad = localidadOficial(nombre, unir(delPunto), punto);
    if (!localidad) {
      console.log(`✗ ${nombre}: la Provincia no la tiene`);
      continue;
    }
    zonas.features.push(localidad);
    yaEstan.add(clave(nombre));
    console.log(`+ ${nombre}: ${delPunto.length ? 'radio urbano oficial' : 'punto oficial'}`);
  }
  await writeFile('data/zonas.geojson', JSON.stringify(zonas, null, 1) + '\n');
  // Un barrio de capital que se llama como una localidad nueva pasa a "X (Córdoba)", como hace el lector.
  const mapa = JSON.parse(await readFile('data/barrios.geojson', 'utf8')) as { features: { properties: { nombre: string | null } }[] };
  const separados = separarDeLocalidades(mapa.features, new Set(zonas.features.filter((z) => z.properties.tipo === 'localidad').map((z) => z.properties.nombre)));
  if (separados > 0) {
    await writeFile('data/barrios.geojson', JSON.stringify(mapa) + '\n');
    console.log(`↔ ${separados} barrios de capital se llaman como una localidad: ahora son "X (Córdoba)"`);
  }
  escribirLugares();
}
