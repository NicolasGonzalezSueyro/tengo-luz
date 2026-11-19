import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarContornos, aplicarPedido, contornoValido, pedidoValido, type ContornoManual } from './contornos.ts';

const cuadrado = (lon: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [[[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat]]],
});
const manual = (nombre: string, destino: ContornoManual['properties']['destino'], localidad?: string): ContornoManual => ({
  type: 'Feature', properties: { nombre, destino, localidad, original: null }, geometry: cuadrado(-64.2, -31.4),
});

test('contornoValido acepta polígonos dentro de Córdoba y rechaza el resto', () => {
  assert.ok(contornoValido(cuadrado(-64.2, -31.4)));
  assert.ok(!contornoValido(cuadrado(-58.4, -34.6))); // Buenos Aires
  assert.ok(!contornoValido({ type: 'Point', coordinates: [-64.2, -31.4] }));
  assert.ok(!contornoValido({ type: 'Polygon', coordinates: [[[-64.2, -31.4], [-64.1, -31.4]]] }));
  assert.ok(!contornoValido(null));
});

test('aplicarContornos reemplaza el contorno del destino y agrega lugares nuevos del interior', () => {
  const barrios = { features: [{ properties: { nombre: 'Alberdi', fuente: 'municipalidad' }, geometry: cuadrado(-64.0, -31.0) }] };
  const manuales = [manual('Alberdi', 'barrios'), manual('Los Cielos', 'interior', 'Córdoba'), manual('Centro (Villa María)', 'interior', 'Villa María')];
  aplicarContornos(barrios, 'barrios', manuales);
  assert.deepEqual(barrios.features[0].geometry, cuadrado(-64.2, -31.4));
  assert.equal(barrios.features[0].properties.fuente, 'manual');

  const interior = { features: [] as { properties: Record<string, unknown>; geometry: unknown }[] };
  aplicarContornos(interior, 'interior', manuales);
  assert.deepEqual(interior.features.map((f) => [f.properties.nombre, f.properties.base, f.properties.localidad]),
    [['Los Cielos', 'Los Cielos', 'Córdoba'], ['Centro (Villa María)', 'Centro', 'Villa María']]);
});

test('pedidoValido: acepta los tres cambios del editor y rechaza lo que no sirve', () => {
  assert.deepEqual(pedidoValido({ accion: 'borrar', nombre: ' Kilómetro 8 ', destino: 'interior', localidad: 'Córdoba', extra: 1 }),
    { accion: 'borrar', nombre: 'Kilómetro 8', destino: 'interior', localidad: 'Córdoba' });
  assert.equal(typeof pedidoValido({ accion: 'contorno', nombre: 'X', destino: 'interior', geometria: cuadrado(-58.4, -34.6) }), 'string'); // fuera de Córdoba
  assert.equal(typeof pedidoValido({ accion: 'contorno', nombre: 'X', destino: 'interior' }), 'string'); // sin contorno
  assert.equal(typeof pedidoValido({ accion: 'otra', nombre: 'X', destino: 'interior' }), 'string');
  assert.equal(typeof pedidoValido({ accion: 'borrar', nombre: 'X', destino: 'calles' }), 'string');
  assert.equal(typeof pedidoValido({ accion: 'borrar', nombre: 'x'.repeat(121), destino: 'interior' }), 'string');
  assert.equal(typeof pedidoValido(null), 'string');
});

test('aplicarPedido: cambiar, borrar y volver al original (también un borrado)', () => {
  const original = cuadrado(-64.0, -31.0);
  const mapa = { features: [{ properties: { nombre: 'Centro (La Calera)', fuente: 'osm', tipo: 'aproximado', localidad: 'La Calera' } as Record<string, unknown>, geometry: original as unknown }] };
  // Cambiar: guarda el original y lo de antes.
  let { manuales } = aplicarPedido([], mapa, { accion: 'contorno', nombre: 'Centro (La Calera)', destino: 'interior', geometria: cuadrado(-64.2, -31.4) });
  assert.equal(manuales.length, 1);
  assert.deepEqual(manuales[0].properties.original, original);
  aplicarContornos(mapa, 'interior', manuales);
  assert.equal(mapa.features[0].properties.fuente, 'manual');
  // Un segundo cambio conserva el original del primero.
  ({ manuales } = aplicarPedido(manuales, mapa, { accion: 'contorno', nombre: 'Centro (La Calera)', destino: 'interior', geometria: cuadrado(-64.3, -31.5) }));
  assert.deepEqual(manuales[0].properties.original, original);
  // Volver al original.
  ({ manuales } = aplicarPedido(manuales, mapa, { accion: 'restaurar', nombre: 'Centro (La Calera)', destino: 'interior' }));
  assert.deepEqual(manuales, []);
  assert.deepEqual(mapa.features[0].geometry, original);
  assert.equal(mapa.features[0].properties.fuente, 'osm');
  // Borrar: sale del mapa y queda anotado (también al regenerar: aplicarContornos lo vuelve a sacar).
  ({ manuales } = aplicarPedido(manuales, mapa, { accion: 'borrar', nombre: 'Centro (La Calera)', destino: 'interior' }));
  assert.equal(mapa.features.length, 0);
  assert.equal(manuales[0].properties.borrado, true);
  const regenerado = { features: [{ properties: { nombre: 'Centro (La Calera)' } as Record<string, unknown>, geometry: original as unknown }] };
  aplicarContornos(regenerado, 'interior', manuales);
  assert.equal(regenerado.features.length, 0);
  // Y volver atrás un borrado: el lugar vuelve con sus datos.
  ({ manuales } = aplicarPedido(manuales, mapa, { accion: 'restaurar', nombre: 'Centro (La Calera)', destino: 'interior' }));
  assert.deepEqual(manuales, []);
  assert.deepEqual(mapa.features.map((f) => [f.properties.nombre, f.properties.localidad, f.properties.fuente]), [['Centro (La Calera)', 'La Calera', 'osm']]);
  assert.deepEqual(mapa.features[0].geometry, original);
});

test('aplicarPedido: un lugar nuevo, y borrarlo antes de que exista en el mapa', () => {
  const mapa = { features: [] as { properties: Record<string, unknown>; geometry: unknown }[] };
  let { manuales } = aplicarPedido([], mapa, { accion: 'contorno', nombre: 'Villa Corema (Río Ceballos)', destino: 'interior', localidad: 'Río Ceballos', geometria: cuadrado(-64.3, -31.17) });
  aplicarContornos(mapa, 'interior', manuales);
  assert.deepEqual(mapa.features.map((f) => [f.properties.nombre, f.properties.base, f.properties.localidad]), [['Villa Corema (Río Ceballos)', 'Villa Corema', 'Río Ceballos']]);
  ({ manuales } = aplicarPedido(manuales, mapa, { accion: 'borrar', nombre: 'Villa Corema (Río Ceballos)', destino: 'interior' }));
  assert.deepEqual(manuales, []); // era nuevo: no queda nada que recordar
  assert.equal(mapa.features.length, 0);
});
