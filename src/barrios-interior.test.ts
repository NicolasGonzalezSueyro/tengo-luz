import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { alRadio, claveDeLugar, enTitulo, km2, mismaLocalidad, sinRepetidos } from './barrios-interior.ts';

test('enTitulo arregla los nombres en mayúsculas de las capas oficiales', () => {
  assert.equal(enTitulo('LAS MERCEDES (EX COLCAR)'), 'Las Mercedes');
  assert.equal(enTitulo('VILLA DEL LAGO'), 'Villa del Lago');
  assert.equal(enTitulo('MANANTIALES II'), 'Manantiales II');
  assert.equal(enTitulo('Barrio Norte'), 'Barrio Norte'); // ya viene bien escrito
});

test('alRadio recorta el casco al radio urbano oficial y lo deja igual si no hay radio o no se tocan', () => {
  const casco = turf.bboxPolygon([-64.50, -31.10, -64.40, -31.00]);
  const radio = turf.bboxPolygon([-64.50, -31.10, -64.45, -31.05]);
  const lejos = turf.bboxPolygon([-63.0, -32.0, -62.9, -31.9]);
  const recortado = alRadio(casco, [radio])!;
  assert.ok(Math.abs(km2(recortado) - km2(radio)) < 0.01);
  assert.equal(alRadio(casco, []), casco);
  assert.equal(alRadio(casco, [lejos]), casco);
  assert.equal(alRadio(null, [radio]), null);
});
test('sinRepetidos deja un barrio por lugar, el más confiable, y guarda el otro nombre como alias', () => {
  const b = (base: string, fuente: string, tipo = 'poligono') => ({ properties: { nombre: `${base} (Malagueño)`, base, localidad: 'Malagueño', tipo, fuente } });
  const lista = [b('Tejas 4', 'nominatim', 'aproximado'), b('Country Tejas Cuatro', 'osm'), b('La Perla', 'osm'), b('LA PERLA', 'municipio')];
  const quedan = sinRepetidos(lista);
  assert.deepEqual(quedan.map((x) => x.properties.base), ['Country Tejas Cuatro', 'LA PERLA']);
  assert.deepEqual((quedan[0].properties as { alias?: string[] }).alias, ['Tejas 4']);
  assert.equal(claveDeLugar('Country Tejas Cuatro'), claveDeLugar('Tejas 4 (Malagueño)'));
});

test('mismaLocalidad: iguales o uno es el comienzo del otro, pero no cualquier palabra en común', () => {
  assert.equal(mismaLocalidad('Villa Yacanto de Calamuchita', 'VILLA YACANTO'), true);
  assert.equal(mismaLocalidad('Malagueño', 'MALAGUEÑO'), true);
  assert.equal(mismaLocalidad('Pampa Alta', 'La Pampa'), false);
});