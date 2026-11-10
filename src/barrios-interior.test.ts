import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { alRadio, claveDeLugar, claveSinLocalidad, enTitulo, km2, mismaLocalidad, sinRepetidos } from './barrios-interior.ts';

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
  assert.equal(mismaLocalidad('James Craik', 'JAMES CRAICK'), true);
  assert.equal(mismaLocalidad('Icho Cruz', 'VILLA RIO ICHO CRUZ'), true);
  assert.equal(mismaLocalidad('Cruz', 'La Cruz'), false); // una sola palabra: no
  assert.equal(mismaLocalidad('Villa Quilino', 'QUILINO'), false); // el Villa cuenta: son dos pueblos
  assert.equal(mismaLocalidad('La Paz', 'La Pez'), false); // cortos: no
});
test('sinRepetidos junta los que se escriben casi igual si están en el mismo lugar, no si están lejos', () => {
  const cuadrado = (x: number) => turf.bboxPolygon([x, -31.5, x + 0.01, -31.49]).geometry;
  const b = (base: string, x: number) => ({ type: 'Feature', geometry: cuadrado(x), properties: { nombre: base, base, localidad: 'Córdoba', tipo: 'poligono', fuente: 'osm' } });
  const quedan = sinRepetidos([b('Brisas de Manantiales', -64.2), b('Brisas de Manatiales', -64.2), b('Brisas de Manantiale', -63.5)]);
  assert.deepEqual(quedan.map((x) => x.properties.base), ['Brisas de Manantiales', 'Brisas de Manantiale']);
});
test('claveSinLocalidad: "El Talar de Mendiolaza" es "El Talar", "Villa Allende Centro" es "Centro"', () => {
  assert.equal(claveSinLocalidad('El Talar de Mendiolaza', 'Mendiolaza'), claveSinLocalidad('El Talar', 'Mendiolaza'));
  assert.equal(claveSinLocalidad('Villa Allende Centro', 'Villa Allende'), claveSinLocalidad('Centro', 'Villa Allende'));
  assert.equal(claveDeLugar('Las Cañitas Barrio Privado'), claveDeLugar('Las Cañitas'));
  assert.notEqual(claveSinLocalidad('Nuevo Malagueño', 'Malagueño'), claveSinLocalidad('Malagueño', 'Malagueño'));
});
test('sinRepetidos entre localidades: el mismo barrio en el mismo lugar se va la copia de capital', () => {
  const cuadrado = turf.bboxPolygon([-64.30, -31.32, -64.29, -31.31]).geometry;
  const b = (localidad: string, fuente: string) => ({ type: 'Feature', geometry: cuadrado, properties: { nombre: `San Remo (${localidad})`, base: 'San Remo', localidad, tipo: 'poligono', fuente } });
  assert.deepEqual(sinRepetidos([b('Córdoba', 'osm'), b('Saldán', 'osm')]).map((x) => x.properties.localidad), ['Saldán']);
  // Entre dos localidades del interior quedan los dos: EPEC puede nombrarlo en cualquiera.
  assert.deepEqual(sinRepetidos([b('Saldán', 'osm'), b('Villa Allende', 'municipio')]).map((x) => x.properties.localidad), ['Saldán', 'Villa Allende']);
});
test('sinRepetidos junta variantes de la misma localidad que se pisan ("Manuel Belgrano" y "Belgrano")', () => {
  const cuadrado = turf.bboxPolygon([-64.50, -31.42, -64.49, -31.41]).geometry;
  const b = (base: string) => ({ type: 'Feature', geometry: cuadrado, properties: { nombre: `${base} (Villa Carlos Paz)`, base, localidad: 'Villa Carlos Paz', tipo: 'poligono', fuente: 'osm' } });
  assert.equal(sinRepetidos([b('Manuel Belgrano'), b('Belgrano')]).length, 1);
  assert.equal(sinRepetidos([b('Costa Azul'), b('Villa Balnearia')]).length, 2); // nombres distintos: no
});
