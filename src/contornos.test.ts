import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarContornos, contornoValido, type ContornoManual } from './contornos.ts';

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
